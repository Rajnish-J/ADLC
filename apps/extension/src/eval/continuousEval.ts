// Phase 5D — continuous evaluation (pure decision core).
//
// Extends the Phase-3 PR-time gate to PRODUCTION traffic: instead of gating one change pre-merge, we
// periodically SAMPLE recent governed runs, re-score them, and raise alerts when quality regresses or
// when evaluation spend runs away. Deliberately framework-free (no `vscode`, no SDK) so the
// sample/breach/spend rules are exhaustively unit-testable — the side-effecting alert delivery lives
// in alertSink.ts. Reuses the Phase-3 score/usage shapes (EvalScore, EvalUsage). See plan §5D.

import type { EvalScore, EvalUsage } from './types'
import type { SdlcStep } from './sdlcSteps'
import type { RunState } from '../runtime/port'

/** Cost discipline (plan §4): sample, not every step; alert when eval spend dwarfs inference spend. */
export interface ContinuousEvalConfig {
  enabled: boolean
  /** Fraction (0,1] of recent runs to re-score. Bounds cost — never every run. */
  sampleRate: number
  /** Floor on sampled runs so a small population is still covered. */
  minSamples: number
  /** A sampled score below this (per required evaluator) raises a quality-regression alert. */
  alertThreshold: number
  /** Alert when eval tokens / inference tokens exceeds this ratio (~0.10–0.15 per plan §4). */
  evalSpendBudgetRatio: number
}

export const DEFAULT_CONTINUOUS_CONFIG: ContinuousEvalConfig = {
  enabled: false,
  sampleRate: 0.25,
  minSamples: 5,
  alertThreshold: 0.7,
  evalSpendBudgetRatio: 0.15,
}

/** One production run/trace eligible for re-scoring. */
export interface RunSample {
  runId: string
  /** SDLC step the run was gated at, when known. */
  step?: SdlcStep
  scores: EvalScore[]
  /** Tokens the evaluators consumed re-scoring this run. */
  evalUsage: EvalUsage
}

export type ContinuousAlertKind = 'quality-regression' | 'eval-spend'

export interface ContinuousAlert {
  kind: ContinuousAlertKind
  runId?: string
  step?: SdlcStep
  evaluator?: string
  /** Observed value (score, or spend ratio). */
  value: number
  /** The threshold/budget it crossed. */
  threshold: number
  message: string
}

export interface ContinuousEvalReport {
  /** Number of runs actually sampled. */
  sampledCount: number
  alerts: ContinuousAlert[]
  /** eval / inference spend ratio observed this cycle. */
  spendRatio: number
}

/**
 * Deterministic stride sample of recent runs (most-recent-first input). Stride sampling — not random —
 * so the cycle is reproducible and unit-testable, while still spreading coverage across the window.
 * Always keeps at least `minSamples` (capped at the population size).
 */
export function sampleRuns(recent: RunSample[], rate: number, minSamples: number): RunSample[] {
  if (recent.length === 0) return []
  const target = Math.max(Math.min(minSamples, recent.length), Math.ceil(recent.length * clamp01(rate)))
  if (target >= recent.length) return [...recent]
  const stride = recent.length / target
  const out: RunSample[] = []
  for (let i = 0; i < target; i++) {
    out.push(recent[Math.floor(i * stride)])
  }
  return out
}

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1 ? 1 : n
}

/**
 * Run a continuous-evaluation cycle over already-scored samples. Produces quality-regression alerts
 * (any evaluator scoring below alertThreshold) and a single eval-spend alert when the eval/inference
 * token ratio exceeds the budget. `inferenceTokens` is the model-inference spend to compare against.
 */
export function evaluateContinuous(
  samples: RunSample[],
  config: ContinuousEvalConfig,
  inferenceTokens: number,
): ContinuousEvalReport {
  const alerts: ContinuousAlert[] = []

  let evalTokens = 0
  for (const s of samples) {
    evalTokens += s.evalUsage.tokensIn + s.evalUsage.tokensOut
    for (const score of s.scores) {
      if (score.score !== null && score.score < config.alertThreshold) {
        alerts.push({
          kind: 'quality-regression',
          runId: s.runId,
          step: s.step,
          evaluator: score.evaluator,
          value: score.score,
          threshold: config.alertThreshold,
          message: `${score.evaluator} scored ${score.score.toFixed(2)} (< ${config.alertThreshold}) on run ${s.runId}${s.step ? ` [${s.step}]` : ''}`,
        })
      }
    }
  }

  const spendRatio = inferenceTokens > 0 ? evalTokens / inferenceTokens : evalTokens > 0 ? Infinity : 0
  if (spendRatio > config.evalSpendBudgetRatio) {
    alerts.push({
      kind: 'eval-spend',
      value: spendRatio,
      threshold: config.evalSpendBudgetRatio,
      message: `Eval spend is ${(spendRatio * 100).toFixed(0)}% of inference spend (budget ${(config.evalSpendBudgetRatio * 100).toFixed(0)}%).`,
    })
  }

  return { sampledCount: samples.length, alerts, spendRatio }
}

/**
 * Derive re-scoring samples from completed runs already in hand (no Foundry backend required). Each
 * run's gate-step decisions become EvalScores, and per-step token usage becomes the eval spend — so a
 * production run that was gated below threshold surfaces as a low score this cycle. Pure + testable.
 */
export function runStatesToSamples(runs: RunState[]): RunSample[] {
  const samples: RunSample[] = []
  for (const run of runs) {
    const scores: EvalScore[] = []
    let tokensIn = 0
    let tokensOut = 0
    for (const step of run.steps) {
      if (!step.gateDecision) continue
      // Gate-step tokens approximate the evaluator/judge spend this cycle.
      tokensIn += step.tokensIn ?? 0
      tokensOut += step.tokensOut ?? 0
      for (const d of step.gateDecision.perEvaluator) {
        scores.push({
          evaluator: d.evaluator,
          score: d.score,
          passed: d.pass ? 1 : 0,
          failed: d.pass ? 0 : 1,
          errored: 0,
        })
      }
    }
    if (scores.length === 0) continue
    samples.push({ runId: run.runId, scores, evalUsage: { tokensIn, tokensOut } })
  }
  return samples
}

/** Total model-inference tokens across the given runs' agent steps — the denominator for spendRatio. */
export function inferenceTokensOf(runs: RunState[]): number {
  let total = 0
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.kind === 'agent') total += (step.tokensIn ?? 0) + (step.tokensOut ?? 0)
    }
  }
  return total
}
