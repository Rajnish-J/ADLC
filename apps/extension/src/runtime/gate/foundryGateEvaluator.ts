// Phase 3 -> Phase 4 bridge — the REAL in-run gate. Replaces StubGateEvaluator (a keyword check on the word
// "fail") with the Phase-3 pipeline: build a one-row dataset from the step's output, run the Foundry
// evaluators the step's policy names, and turn the scores into a block/pass with `decideGate`. Same stages as
// the "Govern & Evaluate" command, but invoked from inside a run so a failing step actually halts it.
//
// Framework-free (no `vscode`): every environment-touching piece — policy lookup, project endpoint, the eval
// runner, audit/trace — is injected, so the decision logic is unit-testable offline with a fake runner. The
// vscode glue lives in gateWiring.ts.

import { buildDataset, toolRequiringEvaluators } from '../../eval/datasetBuilder'
import { decideGate } from '../../eval/gateDecision'
import type { EvalRunner } from '../../eval/evalClient'
import { LOWER_IS_BETTER, type SdlcStep } from '../../eval/sdlcSteps'
import type { EvalRunResult, EvaluatorDecision, GateDecision, GatePolicy, StepPolicy } from '../../eval/types'
import type { GateEvaluationInput, GateEvaluator } from '../port'

/** Transport/polling knobs for one evaluation (a subset of RuntimeEvalConfig). */
export interface GateRunConfig {
  transport: 'sdk' | 'fetch'
  pollIntervalMs: number
  pollTimeoutMs: number
}

/** Handed to `onResult` after every evaluation that reached the evaluators, for audit + tracing. */
export interface GateResultEvent {
  result: EvalRunResult
  decision: GateDecision
  step: SdlcStep
  policy: GatePolicy
  projectEndpoint: string
  timestamp: string
}

export interface FoundryGateDeps {
  runner: EvalRunner
  resolvePolicy: () => Promise<GatePolicy>
  runConfig: () => GateRunConfig
  /** The Foundry project endpoint to evaluate against, or undefined when none is available. */
  resolveProjectEndpoint: () => Promise<string | undefined>
  /** Audit/trace hook. A throwing hook must never change the gate outcome. */
  onResult?: (event: GateResultEvent) => Promise<void> | void
  now?: () => Date
}

/** A decision for "we could not evaluate": blocks when the policy is fail-closed, passes when fail-open. */
function couldNotEvaluate(reason: string, failClosed: boolean): GateDecision {
  return {
    pass: !failClosed,
    perEvaluator: [],
    reason: `${reason} (${failClosed ? 'fail-closed' : 'fail-open'})`,
  }
}

export class FoundryGateEvaluator implements GateEvaluator {
  constructor(private readonly deps: FoundryGateDeps) {}

  async evaluate(input: GateEvaluationInput): Promise<GateDecision> {
    const fullPolicy = await this.deps.resolvePolicy()
    const configured = fullPolicy.steps[input.sdlcStep]
    if (!configured || configured.evaluators.length === 0) {
      return { pass: true, perEvaluator: [], reason: `no evaluators configured for the "${input.sdlcStep}" step` }
    }

    // An in-run gate sees one (query, response) pair — there is no tool-call trace. Evaluators that hard-require
    // tool definitions (tool_call_accuracy, which the default implement/review steps list as REQUIRED) would
    // error on every row, and a fail-closed policy would then block every such step no matter what the agent
    // did. Same rule the Evaluate command applies: drop what cannot run — but record it in the decision rather
    // than weakening the gate silently.
    const cannotRun = new Set(toolRequiringEvaluators(configured.evaluators))
    const stepPolicy: StepPolicy = {
      evaluators: configured.evaluators.filter((e) => !cannotRun.has(e)),
      required: configured.required.filter((e) => !cannotRun.has(e)),
      thresholds: configured.thresholds,
    }
    const policy: GatePolicy = { ...fullPolicy, steps: { ...fullPolicy.steps, [input.sdlcStep]: stepPolicy } }
    const skipped: EvaluatorDecision[] = [...cannotRun].map((evaluator) => ({
      evaluator,
      score: null,
      threshold: configured.thresholds[evaluator] ?? null,
      required: configured.required.includes(evaluator),
      pass: true,
      reason: 'skipped — needs tool-call data that an in-run gate does not have',
    }))
    const withSkips = (d: GateDecision): GateDecision =>
      skipped.length === 0
        ? d
        : {
            ...d,
            perEvaluator: [...d.perEvaluator, ...skipped],
            reason: `${d.reason} (skipped: ${skipped.map((s) => s.evaluator).join(', ')})`,
          }

    if (stepPolicy.evaluators.length === 0) {
      return withSkips({ pass: true, perEvaluator: [], reason: `no evaluator can assess the "${input.sdlcStep}" step from an in-run output` })
    }

    const projectEndpoint = await this.deps.resolveProjectEndpoint()
    if (!projectEndpoint) {
      return withSkips(couldNotEvaluate('no Foundry project is configured for gate evaluation', policy.failClosedOnError))
    }

    const timestamp = (this.deps.now?.() ?? new Date()).toISOString()
    const dataset = buildDataset([], policy, {
      step: input.sdlcStep,
      name: `sdlc-${input.sdlcStep}-${timestamp}`,
      // One row: what the step was asked to do, and what it produced. Evaluators such as task adherence and
      // intent resolution need the query; coherence and the safety evaluators only read the response.
      rows: [{ query: input.query?.trim() || '(no task was provided to this run)', response: input.output }],
    })

    const run = this.deps.runConfig()
    let result: EvalRunResult
    try {
      result = await this.deps.runner.run(dataset, {
        projectEndpoint,
        transport: run.transport,
        pollIntervalMs: run.pollIntervalMs,
        pollTimeoutMs: run.pollTimeoutMs,
        isCancelled: () => input.signal?.aborted ?? false,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return withSkips(couldNotEvaluate(`evaluation failed: ${message}`, policy.failClosedOnError))
    }

    // LOWER_IS_BETTER: content-safety evaluators return a severity where a HIGHER score is WORSE.
    const decision: GateDecision = {
      ...withSkips(decideGate(result.scores, stepPolicy, policy.failClosedOnError, LOWER_IS_BETTER)),
      ...(result.reportUrl ? { reportUrl: result.reportUrl } : {}),
    }

    try {
      await this.deps.onResult?.({ result, decision, step: input.sdlcStep, policy, projectEndpoint, timestamp })
    } catch {
      // Audit/trace are best effort here; the decision stands regardless.
    }
    return decision
  }
}

/**
 * `auto` mode: use the Foundry gate when it can actually run, otherwise fall back to the offline stub — and
 * say so in the decision's reason, so the audit trail never presents a stub verdict as a real evaluation.
 */
export class AutoGateEvaluator implements GateEvaluator {
  constructor(
    private readonly foundry: GateEvaluator,
    private readonly fallback: GateEvaluator,
    /** True when a Foundry evaluation can run right now (signed in AND a project endpoint is configured). */
    private readonly isFoundryAvailable: () => Promise<boolean>,
    /** Called at most once per runtime, the first time the fallback is used. */
    private readonly onFallback: (message: string) => void,
  ) {}

  private warned = false

  async evaluate(input: GateEvaluationInput): Promise<GateDecision> {
    if (await this.isFoundryAvailable()) return this.foundry.evaluate(input)

    if (!this.warned) {
      this.warned = true
      this.onFallback(
        'Workflow gates are using the offline stub (it only checks for the word "fail"). Sign in to Azure and set ' +
          'sdlcGovernance.gate.projectEndpoint to enforce them with Foundry evaluators.',
      )
    }
    const decision = await this.fallback.evaluate(input)
    return { ...decision, reason: `[offline stub gate — Foundry not configured] ${decision.reason}` }
  }
}
