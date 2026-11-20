// Phase 3 — the pure pass/fail engine. THIS is the enforcement core.
//
// Given the normalized scores from a Foundry evals run and the resolved gate
// policy for an SDLC step, decide whether the gate passes. Rules, in order:
//   • If the evaluator returned a numeric mean score, pass = score ≥ threshold.
//   • Else, if it returned pass/fail row counts (the service applied the
//     threshold we injected into the dataset), pass = no failed rows.
//   • An evaluator that errored, or returned neither a score nor counts, fails
//     closed when policy.failClosedOnError is true; otherwise it passes.
//   • The overall gate passes only if EVERY `required` evaluator passes.
//
// No score with no consequence — `decideGate` is what turns a number into a
// block. Kept dependency-free and exhaustively unit-tested.

import type { EvalScore, EvaluatorDecision, EvaluatorRef, GateDecision, StepPolicy } from './types'

export function decideGate(
  scores: EvalScore[],
  step: StepPolicy,
  failClosedOnError: boolean,
  /**
   * Evaluators whose numeric score is a SEVERITY where lower is better (e.g.
   * content-safety). For these, pass = score ≤ threshold instead of ≥. Defaults
   * to none, so quality evaluators keep "higher is better" semantics.
   */
  lowerIsBetter: ReadonlySet<EvaluatorRef> = new Set(),
): GateDecision {
  const byEvaluator = new Map(scores.map((s) => [s.evaluator, s]))
  const requiredSet = new Set(step.required)
  const perEvaluator: EvaluatorDecision[] = []

  for (const evaluator of step.evaluators) {
    const threshold = step.thresholds[evaluator] ?? null
    const required = requiredSet.has(evaluator)
    const score = byEvaluator.get(evaluator)

    if (!score) {
      perEvaluator.push({
        evaluator,
        score: null,
        threshold,
        required,
        pass: !failClosedOnError,
        reason: failClosedOnError
          ? 'no result returned (fail-closed)'
          : 'no result returned (fail-open)',
      })
      continue
    }

    if (score.errored > 0 && failClosedOnError) {
      perEvaluator.push({
        evaluator,
        score: score.score,
        threshold,
        required,
        pass: false,
        reason: `${score.errored} row(s) errored (fail-closed)`,
      })
      continue
    }

    if (score.score === null) {
      // No numeric score — fall back to pass/fail counts (the service applied
      // the threshold we injected into the dataset).
      const hasCounts = score.passed + score.failed > 0
      if (hasCounts) {
        const pass = score.failed === 0
        perEvaluator.push({
          evaluator,
          score: null,
          threshold,
          required,
          pass,
          reason: pass
            ? `${score.passed} row(s) passed`
            : `${score.failed} of ${score.passed + score.failed} row(s) failed`,
        })
        continue
      }
      perEvaluator.push({
        evaluator,
        score: null,
        threshold,
        required,
        pass: !failClosedOnError,
        reason: failClosedOnError ? 'no score or counts (fail-closed)' : 'no score or counts (fail-open)',
      })
      continue
    }

    const lower = lowerIsBetter.has(evaluator)
    const pass = threshold === null ? true : lower ? score.score <= threshold : score.score >= threshold
    const op = pass ? (lower ? '≤' : '≥') : lower ? '>' : '<'
    perEvaluator.push({
      evaluator,
      score: score.score,
      threshold,
      required,
      pass,
      reason:
        threshold === null
          ? 'no threshold configured — informational'
          : `${score.score.toFixed(2)} ${op} ${threshold}`,
    })
  }

  const failedRequired = perEvaluator.filter((d) => d.required && !d.pass)
  const pass = failedRequired.length === 0
  const reason = pass
    ? 'all required evaluators passed'
    : `failed required: ${failedRequired.map((d) => d.evaluator).join(', ')}`

  return { pass, perEvaluator, reason }
}
