// Per-agent evaluate command.
//
// Evaluates a single discovered agent against the Azure AI Foundry Evaluation API for a chosen
// SDLC step. Triggered from both the Discovered Agents tree view (inline button) and the
// Workflow Canvas (⚡ button on agent nodes). A multi-step QuickInput wizard collects the dataset,
// every poll streams a timestamped line to the SDLC Evaluation Log output channel, and results
// land in the Evaluation Results tab.

import * as vscode from 'vscode'
import { FOUNDRY_SCOPE } from '../foundry/constants'
import { getToken, getAccountLabel, getSession } from '../auth/azureAuth'
import { listAllAccessibleProjects } from '../foundry/foundryClient'
import { discover } from '../discovery/normalizer'
import type { InternalAgent } from '../discovery/agentModel'
import { SDLC_STEPS, STEP_LABELS, LOWER_IS_BETTER, type SdlcStep } from '../eval/sdlcSteps'
import { buildDataset, requiresResponse, toolRequiringEvaluators } from '../eval/datasetBuilder'
import { decideGate } from '../eval/gateDecision'
import { tryCreateProjectClient, EvalApiError } from '../eval/evalClient'
import { ensureCustomEvaluators } from '../eval/customEvaluators'
import { resolvePolicy, readRuntimeConfig } from '../eval/settings'
import { buildAuditRecords } from '../audit/auditRecord'
import {
  parsePastedRows,
  parseDatasetFile,
  responsesFor,
  PASTE_SCHEMA_PLACEHOLDER,
  type DatasetRow,
} from '../eval/datasetInput'
import type { AuditStore } from '../audit/auditStore'
import type { LogAnalyticsSink } from '../audit/logAnalyticsSink'
import type { EvalRunner } from '../eval/evalClient'
import type { EvaluationResultsProvider } from '../views/evaluationResultsProvider'
import type { EvalLog } from '../telemetry/evalOutputChannel'

export interface EvaluateAgentDeps {
  runner: EvalRunner
  store: AuditStore
  results: EvaluationResultsProvider
  logSink: LogAnalyticsSink
  channel: EvalLog
}

/** The user's dataset choice, normalized across all three wizard sources. */
export interface CollectedDataset {
  source: 'auto' | 'paste' | 'file'
  /** User-supplied rows (empty for auto-derive). */
  rows: DatasetRow[]
}

async function pickStep(): Promise<SdlcStep | undefined> {
  const pick = await vscode.window.showQuickPick(
    SDLC_STEPS.map((s) => ({ label: STEP_LABELS[s], step: s })),
    { placeHolder: 'Which SDLC step are you governing?' },
  )
  return pick?.step
}

/** Resolve the target agent from a tree-view item (has .agent), a raw InternalAgent, or an agentId string. */
async function resolveAgent(arg: unknown): Promise<InternalAgent | undefined> {
  if (!arg) return undefined

  // Tree view item: { agent: InternalAgent }
  if (typeof arg === 'object' && 'agent' in (arg as object)) {
    return (arg as { agent: InternalAgent }).agent
  }

  // Direct InternalAgent object
  if (typeof arg === 'object' && 'id' in (arg as object) && 'name' in (arg as object)) {
    return arg as InternalAgent
  }

  // agentId string from the canvas
  if (typeof arg === 'string') {
    const { agents } = await discover()
    const found = agents.find((a) => a.id === arg)
    if (!found) {
      void vscode.window.showWarningMessage(
        `Agent "${arg}" not found in workspace. Run Discover first.`,
      )
    }
    return found
  }

  return undefined
}

/**
 * Step 1 of the wizard: choose where the evaluation dataset comes from and collect it.
 * Returns undefined when the user cancels at any sub-step. The parsing/validation is
 * delegated to the pure helpers in datasetInput.ts so it's unit-testable.
 */
export async function collectDataset(agent: InternalAgent): Promise<CollectedDataset | undefined> {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(sparkle) Auto-derive from agent description',
        description: 'Build the query from the agent’s description or name',
        source: 'auto' as const,
      },
      {
        label: '$(json) Paste JSON rows',
        description: 'Paste a JSON array of {query, response, ground_truth} rows',
        source: 'paste' as const,
      },
      {
        label: '$(file) Load from file',
        description: 'Pick a .json or .jsonl dataset file',
        source: 'file' as const,
      },
    ],
    { title: `Evaluate Agent: ${agent.name}`, placeHolder: 'Choose the dataset source' },
  )
  if (!choice) return undefined

  if (choice.source === 'auto') {
    return { source: 'auto', rows: [] }
  }

  if (choice.source === 'paste') {
    // Loop until the JSON is valid or the user cancels (AC-1).
    let value = PASTE_SCHEMA_PLACEHOLDER
    for (;;) {
      const input = await vscode.window.showInputBox({
        title: `Evaluate Agent: ${agent.name} — paste dataset`,
        prompt: 'Paste a JSON array of rows. Each row needs a "query"; "response"/"ground_truth" are optional.',
        value,
        valueSelection: [1, value.length - 1],
      })
      if (input === undefined) return undefined // cancelled
      const parsed = parsePastedRows(input)
      if (parsed.ok) {
        return { source: 'paste', rows: parsed.rows }
      }
      value = input
      void vscode.window.showErrorMessage(`Dataset invalid: ${parsed.error}`)
    }
  }

  // Load from file.
  const uris = await vscode.window.showOpenDialog({
    title: `Evaluate Agent: ${agent.name} — load dataset`,
    canSelectMany: false,
    openLabel: 'Use dataset',
    filters: { Datasets: ['json', 'jsonl'] },
  })
  if (!uris || uris.length === 0) return undefined
  const uri = uris[0]
  const ext = uri.path.slice(uri.path.lastIndexOf('.'))
  let content: string
  try {
    content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not read dataset file: ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }
  const parsed = parseDatasetFile(content, ext)
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(`Dataset invalid: ${parsed.error}`)
    return undefined
  }
  void vscode.window.showInformationMessage(`Loaded ${parsed.rows.length} dataset row(s).`)
  return { source: 'file', rows: parsed.rows }
}

export async function evaluateAgent(arg: unknown, deps: EvaluateAgentDeps): Promise<void> {
  const agent = await resolveAgent(arg)
  if (!agent) {
    void vscode.window.showWarningMessage('No agent selected for evaluation.')
    return
  }

  // Auth.
  const session = await getSession(FOUNDRY_SCOPE, true)
  if (!session) {
    const action = await vscode.window.showWarningMessage(
      'Sign in to Azure first to evaluate an agent.',
      'Sign in to Azure',
    )
    if (action === 'Sign in to Azure') {
      await vscode.commands.executeCommand('sdlcGovernance.signIn')
    }
    return
  }

  // Step 1 — dataset.
  const collected = await collectDataset(agent)
  if (!collected) return

  // Step 2 — SDLC step.
  const step = await pickStep()
  if (!step) return

  const policy = await resolvePolicy()
  const runtime = readRuntimeConfig()
  const stepPolicy = policy.steps[step]
  if (!stepPolicy || stepPolicy.evaluators.length === 0) {
    void vscode.window.showWarningMessage(`No evaluators configured for the "${STEP_LABELS[step]}" step.`)
    return
  }

  // Tool-call evaluators hard-require tool_definitions; Foundry treats an empty
  // list as "none" and errors every row. If the agent has no tools (and the user
  // didn't supply tool_definitions), drop those evaluators with a warning so the
  // applicable ones still run and the gate doesn't fail on an inapplicable check.
  const toolEvals = toolRequiringEvaluators(stepPolicy.evaluators)
  const toolDefsAvailable =
    agent.tools.length > 0 ||
    collected.rows.some((r) => {
      const td = (r as Record<string, unknown>).tool_definitions
      return Array.isArray(td) && td.length > 0
    })
  let effectiveStep = stepPolicy
  if (toolEvals.length > 0 && !toolDefsAvailable) {
    const drop = new Set(toolEvals)
    effectiveStep = {
      evaluators: stepPolicy.evaluators.filter((e) => !drop.has(e)),
      required: stepPolicy.required.filter((e) => !drop.has(e)),
      thresholds: Object.fromEntries(
        Object.entries(stepPolicy.thresholds).filter(([e]) => !drop.has(e)),
      ),
    }
    if (effectiveStep.evaluators.length === 0) {
      void vscode.window.showWarningMessage(
        `"${agent.name}" has no tools, so the only evaluator(s) for ${STEP_LABELS[step]} ` +
          `(${toolEvals.join(', ')}) can't be evaluated. Nothing to run.`,
      )
      return
    }
    void vscode.window.showWarningMessage(
      `"${agent.name}" has no tools — skipping ${toolEvals.join(', ')} for ${STEP_LABELS[step]}.`,
    )
  }
  // The policy passed to the dataset builder / gate uses the effective step set.
  const effectivePolicy = { ...policy, steps: { ...policy.steps, [step]: effectiveStep } }

  // Step 3 — Foundry project.
  const projects = await listAllAccessibleProjects(getToken)
  if (projects.length === 0) {
    void vscode.window.showWarningMessage(
      'No Foundry projects accessible — check your Azure subscription.',
    )
    return
  }
  const projectPick = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: p.displayName, description: p.accountName, project: p })),
    { placeHolder: 'Select the Foundry project to evaluate against' },
  )
  if (!projectPick) return
  const project = projectPick.project

  const stamp = new Date().toISOString()
  const responsesByAgentId =
    collected.rows.length > 0 ? responsesFor(agent.id, collected.rows) : undefined
  const dataset = buildDataset([agent], effectivePolicy, {
    step,
    name: `sdlc-agent-${step}-${stamp}`,
    rows: collected.rows.length > 0 ? collected.rows : undefined,
    responsesByAgentId,
  })

  // These evaluators score an agent *response*. An empty response makes Foundry
  // error every row (the `errored:N` symptom), so block before spending a run.
  if (requiresResponse(effectiveStep.evaluators)) {
    const everyRowHasResponse = dataset.data.every(
      (r) => typeof r.response === 'string' && r.response.trim().length > 0,
    )
    if (!everyRowHasResponse) {
      const detail =
        collected.source === 'auto'
          ? 'auto-derive supplies only a query'
          : 'one or more rows have no "response"'
      void vscode.window.showWarningMessage(
        `The ${STEP_LABELS[step]} evaluators score an agent response, but ${detail}. ` +
          'Paste or load a dataset where every row includes a non-empty "response".',
      )
      return
    }
  }

  if (runtime.customEvaluators) {
    const client = await tryCreateProjectClient(project.projectEndpoint, getToken)
    if (client) {
      const extra = await ensureCustomEvaluators(client, policy.judgeDeployment, (m) =>
        vscode.window.showInformationMessage(m),
      )
      dataset.evaluators.push(...extra)
    }
  }

  deps.channel.reveal()

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Evaluating "${agent.name}" for ${STEP_LABELS[step]}…`,
      cancellable: true,
    },
    async (progress, cancelToken) => {
      // runId is unknown until the first poll; the helper backfills it once known.
      let runId = `pending-${stamp}`
      const log = (msg: string) => deps.channel.log(runId, msg)
      let loggedCreate = false
      try {
        const result = await deps.runner.run(dataset, {
          projectEndpoint: project.projectEndpoint,
          transport: runtime.transport,
          pollIntervalMs: runtime.pollIntervalMs,
          pollTimeoutMs: runtime.pollTimeoutMs,
          isCancelled: () => cancelToken.isCancellationRequested,
          onProgress: (e) => {
            runId = e.runId
            if (!loggedCreate) {
              log(`Run for "${agent.name}" created (evalId: ${e.evalId})`)
              loggedCreate = true
            }
            log(`status: ${e.status}  (poll ${e.poll}/${e.maxPolls})`)
            progress.report({ message: `${e.status} (poll ${e.poll}/${e.maxPolls})` })
          },
        })
        runId = result.runId

        if (cancelToken.isCancellationRequested) {
          log('Evaluation cancelled by user')
          return
        }

        log(`status: ${result.status}`)
        // TEMP DIAGNOSTIC — show exactly what Foundry returned so we can see why
        // scores are empty (errored rows vs. nothing parsed). Remove once resolved.
        log(`raw scores: ${JSON.stringify(result.scores)}`)
        if (result.errorSamples?.length) {
          for (const sample of result.errorSamples) {
            log(`error: ${sample}`)
          }
        }
        if (result.reportUrl) log(`report: ${result.reportUrl}`)
        const decision = decideGate(
          result.scores,
          effectiveStep,
          policy.failClosedOnError,
          LOWER_IS_BETTER,
        )
        for (const d of decision.perEvaluator) {
          const score = d.score === null ? '—' : d.score.toFixed(1)
          const thr = d.threshold === null ? 'n/a' : String(d.threshold)
          log(`${d.evaluator}=${score}/${thr} ${d.pass ? '✓' : '✗'}`)
        }
        log(`Gate: ${decision.pass ? 'PASSED' : 'FAILED'} — ${decision.reason}`)

        const actor = (await getAccountLabel(FOUNDRY_SCOPE)) ?? 'unknown'
        const records = buildAuditRecords({
          result,
          decision,
          step,
          actor,
          source: 'extension',
          projectEndpoint: project.projectEndpoint,
          timestamp: stamp,
          agentId: agent.id,
        })
        await deps.store.append(records)
        try {
          await deps.logSink.push(records)
        } catch {
          // Log Analytics push is best-effort.
        }

        deps.results.refresh(result.runId)
        await vscode.commands.executeCommand('sdlcGovernance.showEvaluations')

        if (decision.pass) {
          void vscode.window.showInformationMessage(
            `"${agent.name}" PASSED for ${STEP_LABELS[step]} — ${decision.reason}.`,
          )
        } else {
          void vscode.window.showWarningMessage(
            `"${agent.name}" FAILED for ${STEP_LABELS[step]} — ${decision.reason}.`,
          )
        }
      } catch (err) {
        if (cancelToken.isCancellationRequested) {
          log('Evaluation cancelled by user')
          return
        }
        reportEvalError(err, log)
      }
    },
  )
}

/** Log structured detail to the channel and surface a friendly notification (AC-5, AC-7). */
function reportEvalError(err: unknown, log: (msg: string) => void): void {
  if (err instanceof EvalApiError) {
    log(`ERROR ${err.status} from ${err.endpoint}`)
    log(err.body || err.message)
    let hint = ''
    if (err.status === 401 || err.status === 403) {
      hint = ' Check your Azure sign-in and project access.'
    } else if (err.status === 400 && /schema|data_source|item_schema/i.test(err.body)) {
      hint =
        ' Dataset schema rejected — see https://learn.microsoft.com/azure/ai-foundry/how-to/develop/evaluate-sdk'
    }
    void vscode.window.showErrorMessage(`Evaluation failed (${err.status}).${hint}`)
    return
  }
  const msg = err instanceof Error ? err.message : String(err)
  log(`ERROR ${msg}`)
  void vscode.window.showErrorMessage(`Evaluation failed: ${msg}`)
}
