// Phase 3 — evaluation domain types.
//
// The pure data shapes shared across the evaluation flow: gate policy (which
// evaluators gate which SDLC step, and at what threshold), the normalized score
// shape extracted from a Foundry evals run, and the gate decision the policy
// engine produces. These are deliberately framework-free (no `vscode`, no SDK
// types) so every consumer — the SDK client, the fetch fallback, the ADO dataset
// builder, the audit store, and the unit tests — depends on the same contract.

import type { SdlcStep } from './sdlcSteps'

/** A reference to a Foundry evaluator, e.g. `builtin.task_adherence`. */
export type EvaluatorRef = string

/** Sampling strategy applied to a dataset to bound evaluation cost. */
export interface SamplingPolicy {
  strategy: 'none' | 'ratio' | 'headN'
  /** Fraction in (0, 1] when strategy is `ratio`. */
  ratio?: number
  /** Floor on the number of rows kept when strategy is `ratio`. */
  minRows?: number
  /** Number of rows kept when strategy is `headN`. */
  n?: number
}

/** Per-step gate configuration: which evaluators run, which gate, their thresholds. */
export interface StepPolicy {
  /** All evaluators to run for this step. */
  evaluators: EvaluatorRef[]
  /** Subset of `evaluators` that must pass for the gate to pass. */
  required: EvaluatorRef[]
  /** Minimum score (inclusive) for each evaluator to count as a pass. */
  thresholds: Record<EvaluatorRef, number>
}

/** The resolved gate policy (workspace overrides merged over config defaults). */
export interface GatePolicy {
  /** Azure OpenAI judge-model deployment name used by AI-assisted evaluators. */
  judgeDeployment: string
  sampling: SamplingPolicy
  /** A failed/errored evaluator result counts as a fail when true. */
  failClosedOnError: boolean
  steps: Partial<Record<SdlcStep, StepPolicy>>
}

/** One evaluator's normalized result for a run (aggregated across rows). */
export interface EvalScore {
  evaluator: EvaluatorRef
  /** Aggregate score (e.g. mean across rows), or null when unavailable. */
  score: number | null
  /** Rows that passed / failed / errored for this evaluator. */
  passed: number
  failed: number
  errored: number
}

/** Token usage extracted from a run, summed across judge-model calls. */
export interface EvalUsage {
  tokensIn: number
  tokensOut: number
}

/** The normalized result of a completed Foundry evals run. */
export interface EvalRunResult {
  evalId: string
  runId: string
  status: string
  reportUrl?: string
  scores: EvalScore[]
  usage: EvalUsage
  /**
   * Sample per-row error messages, pulled from the run's output items when any
   * evaluator reported `errored` rows. Diagnostic only — surfaced in the log so
   * an "errored everywhere" run shows WHY (bad deployment, judge timeout, …).
   */
  errorSamples?: string[]
}

/** One evaluator's contribution to the overall gate decision. */
export interface EvaluatorDecision {
  evaluator: EvaluatorRef
  score: number | null
  threshold: number | null
  required: boolean
  pass: boolean
  reason: string
}

/** The pass/fail verdict the policy engine produces for a run. */
export interface GateDecision {
  pass: boolean
  perEvaluator: EvaluatorDecision[]
  reason: string
  /** Link to the full Foundry evaluation report behind this verdict, when one was produced. */
  reportUrl?: string
}

/** The dataset shape consumed by both the SDK run and the ADO task. */
export interface EvalDataset {
  name: string
  evaluators: EvaluatorRef[]
  data: Array<Record<string, unknown>>
  /**
   * Base/superset mapping (query, response, ground_truth). The in-extension
   * evals API requires an explicit mapping, so the dataset builder always sets
   * it. The ADO `AIAgentEvaluation@2` task auto-generates the mapping (and
   * invokes agents to produce responses), so the scaffolder omits it.
   */
  data_mapping?: Record<string, string>
  /**
   * Per-evaluator data mapping. Each evaluator declares only the fields it
   * consumes (e.g. tool_call_accuracy gets `tool_definitions`, coherence does
   * not). The eval client writes one `testing_criteria` entry per evaluator
   * using its own mapping; falls back to `data_mapping` when absent.
   */
  dataMappings?: Record<EvaluatorRef, Record<string, string>>
  evaluator_parameters: Record<string, unknown>
}
