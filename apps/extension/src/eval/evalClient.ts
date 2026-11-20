// Phase 3 — the eval client. The `foundryClient.ts` analogue: the ONLY module
// in src/eval that touches the network/SDK. Everything else stays pure.
//
// One `EvalRunner` interface, two interchangeable transports:
//   • SDK (primary): lazy-import @azure/ai-projects + openai, build the project
//     client over a credential adapter wrapping the injected TokenProvider, then
//     drive the OpenAI-compatible evals API (create → run → poll).
//   • fetch (fallback / forced): raw HTTP against the project endpoint's
//     /openai/v1/evals routes, reusing the redaction pattern from foundryClient.
//
// Both packages are optionalDependencies + esbuild-external + lazy-imported, so
// a slim install still runs via the fetch transport. We keep the fetch path
// first-class because the evals API is preview and the typed SDK surface lags.

import { FOUNDRY_SCOPE } from '../foundry/constants'
import type { TokenProvider } from '../foundry/foundryClient'
import {
  extractErrorSamples,
  extractReportUrl,
  extractScores,
  extractScoresFromOutputItems,
  extractUsage,
} from './scoreExtraction'
import { SAFETY_EVALUATORS } from './sdlcSteps'
import type { EvalDataset, EvalRunResult, EvalScore } from './types'

export interface RunOptions {
  projectEndpoint: string
  /** 'sdk' (default) or 'fetch'. */
  transport?: 'sdk' | 'fetch'
  pollIntervalMs?: number
  pollTimeoutMs?: number
  /** Cancellation hook — return true to abort polling. */
  isCancelled?: () => boolean
  /** Structured per-poll progress callback (W-4) — carries enough to write a real log line. */
  onProgress?: (event: EvalProgressEvent) => void
}

/** One polling tick's worth of context, emitted to `onProgress` each cycle. */
export interface EvalProgressEvent {
  status: string
  /** 1-based poll index. */
  poll: number
  /** Upper bound on polls before timeout (derived from timeout / interval). */
  maxPolls: number
  evalId: string
  runId: string
}

/**
 * A failed Azure evals API call. Carries the HTTP status, a redacted body
 * snippet, and the endpoint so the command layer can log structured detail and
 * decide how to surface it — the client itself never logs or swallows (W-6).
 */
export class EvalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly endpoint: string,
  ) {
    super(message)
    this.name = 'EvalApiError'
  }
}

export interface EvalRunner {
  run(dataset: EvalDataset, opts: RunOptions): Promise<EvalRunResult>
}

// ─── Minimal structural types for the (untyped, optional) SDK surface ─────────
// The packages are external/optionalDependencies and not present at build time,
// so we describe only the slice we use instead of importing their types.
interface RunLike {
  id: string
  status: string
  [k: string]: unknown
}
interface OpenAILike {
  evals: {
    create(body: Record<string, unknown>): Promise<{ id: string }>
    runs: {
      create(evalId: string, body: Record<string, unknown>): Promise<RunLike>
      retrieve(runId: string, opts: { eval_id: string }): Promise<RunLike>
    }
  }
}
interface ProjectClientLike {
  getOpenAIClient(): OpenAILike
  beta?: unknown
}
type ProjectClientCtor = new (endpoint: string, credential: unknown) => ProjectClientLike

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'cancelled', 'error'])
const DEFAULT_INTERVAL = 5_000
const DEFAULT_TIMEOUT = 600_000

function redact(text: string): string {
  return text.replace(/(eyJ[\w-]{20,})/g, '<token-redacted>')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Per-evaluator `initialization_parameters`. The Azure evaluator constructor
 * accepts only its own kwargs (`deployment_name`, optional `threshold`) — NOT
 * the whole `evaluator_parameters` blob. Passing the blob (with sibling keys
 * like `'builtin.coherence': {threshold: 2}`) makes the evaluator throw on init,
 * so every row reports `errored`. We hand each criterion just its own params.
 */
export function initParamsForEvaluator(
  evaluator: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const init: Record<string, unknown> = {}
  // Safety evaluators run on the hosted safety service and take no deployment.
  if (!SAFETY_EVALUATORS.has(evaluator) && typeof params.deployment_name === 'string') {
    init.deployment_name = params.deployment_name
  }
  const per = params[evaluator]
  if (per && typeof per === 'object' && 'threshold' in (per as Record<string, unknown>)) {
    init.threshold = (per as { threshold: unknown }).threshold
  }
  return init
}

/**
 * Build the eval create/run request bodies from a dataset. Shared by both
 * transports so the request shape is defined once.
 */
export function buildEvalCreateBody(dataset: EvalDataset): Record<string, unknown> {
  return {
    name: dataset.name,
    data_source_config: {
      type: 'custom',
      item_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          response: { type: 'string' },
          ground_truth: { type: 'string' },
          // Agentic evaluators (tool_call_accuracy, etc.) read tool definitions
          // as a list of OpenAI function descriptors mapped from this column.
          tool_definitions: { type: 'array' },
        },
        required: ['query'],
      },
      include_sample_schema: true,
    },
    // One criterion per evaluator, each with the mapping carrying exactly the
    // fields that evaluator requires (per-evaluator mapping; falls back to the
    // base mapping for any evaluator the builder didn't enumerate).
    testing_criteria: dataset.evaluators.map((evaluator) => ({
      type: 'azure_ai_evaluator',
      name: evaluator,
      evaluator_name: evaluator,
      data_mapping: dataset.dataMappings?.[evaluator] ?? dataset.data_mapping,
      initialization_parameters: initParamsForEvaluator(evaluator, dataset.evaluator_parameters),
    })),
  }
}

function buildRunCreateBody(dataset: EvalDataset): Record<string, unknown> {
  return {
    name: `${dataset.name}-run`,
    data_source: {
      type: 'jsonl',
      source: { type: 'file_content', content: dataset.data.map((item) => ({ item })) },
    },
  }
}

function toResult(evalId: string, runId: string, status: string, raw: unknown): EvalRunResult {
  return {
    evalId,
    runId,
    status,
    reportUrl: extractReportUrl(raw),
    scores: extractScores(raw),
    usage: extractUsage(raw),
  }
}

/** True when any evaluator reported one or more errored rows. */
function hasErroredRows(scores: EvalScore[]): boolean {
  return scores.some((s) => s.errored > 0)
}

/** Fetch the run's output items (one per data row). Returns undefined on failure. */
async function fetchOutputItems(
  projectEndpoint: string,
  evalId: string,
  runId: string,
  getToken: TokenProvider,
): Promise<unknown | undefined> {
  try {
    const token = await getToken(FOUNDRY_SCOPE)
    const base = `${projectEndpoint.replace(/\/+$/, '')}/openai/v1`
    const url = `${base}/evals/${encodeURIComponent(evalId)}/runs/${encodeURIComponent(runId)}/output_items`
    return await evalsFetch<unknown>(url, token)
  } catch {
    return undefined
  }
}

/**
 * Enrich a run result from its output items. A *successful* run leaves the run
 * object's criteria summary empty, so we derive scores from the per-row output
 * items (the authoritative source). On errored rows we also pull sample error
 * messages so the log shows why. Best-effort — never throws.
 */
async function enrichFromOutputItems(
  result: EvalRunResult,
  projectEndpoint: string,
  getToken: TokenProvider,
): Promise<void> {
  const resp = await fetchOutputItems(projectEndpoint, result.evalId, result.runId, getToken)
  if (resp === undefined) return

  // Prefer output-item-derived scores when the run summary gave us nothing.
  const derived = extractScoresFromOutputItems(resp)
  if (derived.length > 0 && result.scores.length === 0) {
    result.scores = derived
  }

  if (hasErroredRows(result.scores)) {
    const samples = extractErrorSamples(resp)
    if (samples.length > 0) {
      result.errorSamples = samples
    } else {
      const items = (resp as { data?: unknown[] })?.data
      if (Array.isArray(items) && items.length > 0) {
        result.errorSamples = [`raw output item: ${redact(JSON.stringify(items[0])).slice(0, 800)}`]
      }
    }
  }
}

// ─── Credential adapter ───────────────────────────────────────────────────────
// Wrap the injected TokenProvider into the @azure/core-auth TokenCredential the
// SDK expects, without importing the type (kept loose to avoid a hard dep).
function credentialAdapter(getToken: TokenProvider): unknown {
  return {
    getToken: async () => {
      const token = await getToken(FOUNDRY_SCOPE)
      // We can't read the JWT exp cheaply here; give a conservative 5-min window.
      return { token, expiresOnTimestamp: Date.now() + 5 * 60_000 }
    },
  }
}

// ─── SDK transport ────────────────────────────────────────────────────────────
async function runViaSdk(
  dataset: EvalDataset,
  opts: RunOptions,
  getToken: TokenProvider,
): Promise<EvalRunResult> {
  // Lazy import: the packages are external/optional and untyped at build time.
  const projects = (await import('@azure/ai-projects' as string)) as unknown as {
    AIProjectClient: ProjectClientCtor
  }
  const project = new projects.AIProjectClient(opts.projectEndpoint, credentialAdapter(getToken))
  const openai = project.getOpenAIClient()

  const evalObj = await wrapSdk(
    () => openai.evals.create(buildEvalCreateBody(dataset)),
    `${opts.projectEndpoint}/openai/v1/evals`,
  )
  let run = await wrapSdk(
    () => openai.evals.runs.create(evalObj.id, buildRunCreateBody(dataset)),
    `${opts.projectEndpoint}/openai/v1/evals/${evalObj.id}/runs`,
  )

  const interval = opts.pollIntervalMs ?? DEFAULT_INTERVAL
  const maxPolls = Math.max(1, Math.ceil((opts.pollTimeoutMs ?? DEFAULT_TIMEOUT) / interval))
  const deadline = Date.now() + (opts.pollTimeoutMs ?? DEFAULT_TIMEOUT)
  let poll = 0
  while (!TERMINAL.has(String(run.status))) {
    if (opts.isCancelled?.()) {
      throw new Error('Evaluation run cancelled.')
    }
    if (Date.now() > deadline) {
      throw new Error('Evaluation run timed out before completing.')
    }
    poll += 1
    opts.onProgress?.({
      status: String(run.status),
      poll,
      maxPolls,
      evalId: evalObj.id,
      runId: run.id,
    })
    await sleep(interval)
    run = await wrapSdk(
      () => openai.evals.runs.retrieve(run.id, { eval_id: evalObj.id }),
      `${opts.projectEndpoint}/openai/v1/evals/${evalObj.id}/runs/${run.id}`,
    )
  }
  const result = toResult(evalObj.id, run.id, String(run.status), run)
  await enrichFromOutputItems(result, opts.projectEndpoint, getToken)
  return result
}

/**
 * Run an SDK call, re-wrapping any thrown error as an EvalApiError so callers see
 * one typed error shape regardless of transport. SDK errors expose `status`/
 * `response` loosely; we read them defensively. Module-not-found errors are
 * rethrown untouched so `createEvalRunner` can detect them and fall back to fetch.
 */
async function wrapSdk<T>(call: () => Promise<T>, endpoint: string): Promise<T> {
  try {
    return await call()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/Cannot find module|@azure\/ai-projects|getOpenAIClient|is not a function/.test(msg)) {
      throw err // let the fallback path catch this
    }
    const e = err as { status?: number; statusCode?: number; response?: { status?: number } }
    const status = e.status ?? e.statusCode ?? e.response?.status ?? 0
    throw new EvalApiError(redact(msg), status, redact(msg).slice(0, 200), endpoint)
  }
}

/**
 * Lazily build the loosely-typed AIProjectClient over the injected token
 * provider. Returns undefined if the SDK is unavailable (so callers can degrade
 * — e.g. skip custom-evaluator registration rather than fail the run).
 */
export async function tryCreateProjectClient(
  projectEndpoint: string,
  getToken: TokenProvider,
): Promise<ProjectClientLike | undefined> {
  try {
    const projects = (await import('@azure/ai-projects' as string)) as unknown as {
      AIProjectClient: ProjectClientCtor
    }
    return new projects.AIProjectClient(projectEndpoint, credentialAdapter(getToken))
  } catch {
    return undefined
  }
}

// ─── fetch transport ──────────────────────────────────────────────────────────
async function evalsFetch<T>(
  url: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const body = redact(text).slice(0, 200)
    throw new EvalApiError(
      `Evals request failed (${res.status}): ${body || res.statusText}`,
      res.status,
      body,
      url,
    )
  }
  const raw = await res.text()
  return (raw ? JSON.parse(raw) : {}) as T
}

async function runViaFetch(
  dataset: EvalDataset,
  opts: RunOptions,
  getToken: TokenProvider,
): Promise<EvalRunResult> {
  const token = await getToken(FOUNDRY_SCOPE)
  const base = `${opts.projectEndpoint.replace(/\/+$/, '')}/openai/v1`

  const evalObj = await evalsFetch<{ id: string }>(`${base}/evals`, token, buildEvalCreateBody(dataset))
  let run = await evalsFetch<{ id: string; status: string }>(
    `${base}/evals/${encodeURIComponent(evalObj.id)}/runs`,
    token,
    buildRunCreateBody(dataset),
  )

  const interval = opts.pollIntervalMs ?? DEFAULT_INTERVAL
  const maxPolls = Math.max(1, Math.ceil((opts.pollTimeoutMs ?? DEFAULT_TIMEOUT) / interval))
  const deadline = Date.now() + (opts.pollTimeoutMs ?? DEFAULT_TIMEOUT)
  let raw: { id: string; status: string } = run
  let poll = 0
  while (!TERMINAL.has(String(run.status))) {
    if (opts.isCancelled?.()) {
      throw new Error('Evaluation run cancelled.')
    }
    if (Date.now() > deadline) {
      throw new Error('Evaluation run timed out before completing.')
    }
    poll += 1
    opts.onProgress?.({
      status: String(run.status),
      poll,
      maxPolls,
      evalId: evalObj.id,
      runId: run.id,
    })
    await sleep(interval)
    raw = await evalsFetch<{ id: string; status: string }>(
      `${base}/evals/${encodeURIComponent(evalObj.id)}/runs/${encodeURIComponent(run.id)}`,
      await getToken(FOUNDRY_SCOPE),
    )
    run = raw
  }
  const result = toResult(evalObj.id, run.id, String(run.status), raw)
  await enrichFromOutputItems(result, opts.projectEndpoint, getToken)
  return result
}

/**
 * Create an EvalRunner over the injected token provider. The SDK transport is
 * tried first (unless forced to fetch); if the SDK import fails, it transparently
 * degrades to the fetch transport.
 */
export function createEvalRunner(getToken: TokenProvider): EvalRunner {
  return {
    async run(dataset, opts) {
      if (opts.transport === 'fetch') {
        return runViaFetch(dataset, opts, getToken)
      }
      try {
        return await runViaSdk(dataset, opts, getToken)
      } catch (err) {
        // If the SDK module itself is missing/incompatible, fall back to fetch.
        const msg = err instanceof Error ? err.message : String(err)
        if (/Cannot find module|@azure\/ai-projects|getOpenAIClient|is not a function/.test(msg)) {
          return runViaFetch(dataset, opts, getToken)
        }
        throw err
      }
    },
  }
}
