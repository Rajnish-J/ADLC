// Phase 3 — score & usage extraction. The ONE place the volatile preview
// evals-run response shape is normalized, so a preview API change touches only
// this file (and its golden test), never the gate engine or the panel.
//
// The OpenAI-compatible evals run response we consume looks like:
//   {
//     id, status, report_url,
//     result_counts: { passed, failed, errored, total },
//     per_testing_criteria_results: [
//       { testing_criteria, passed, failed }    // counts per evaluator
//     ],
//     per_model_usage: [
//       { invocation_count, prompt_tokens, completion_tokens, total_tokens }
//     ]
//   }
//
// Field names drift across preview revisions (prompt_tokens vs input_tokens,
// testing_criteria vs name); we read defensively and fall back to 0/null.

import type { EvalScore, EvalUsage } from './types'

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function optNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Normalize each testing-criterion result into an EvalScore. */
export function extractScores(runResponse: unknown): EvalScore[] {
  const resp = (runResponse ?? {}) as Record<string, unknown>
  const criteria = Array.isArray(resp.per_testing_criteria_results)
    ? (resp.per_testing_criteria_results as Array<Record<string, unknown>>)
    : []

  return criteria.map((c) => {
    const evaluator = String(c.testing_criteria ?? c.name ?? c.evaluator ?? 'unknown')
    // A numeric mean score if the service supplies one; otherwise null and the
    // gate falls back to pass/fail counts.
    const score =
      optNum(c.score) ?? optNum(c.mean_score) ?? optNum((c.aggregated as Record<string, unknown>)?.score) ?? null
    return {
      evaluator,
      score,
      passed: num(c.passed),
      failed: num(c.failed),
      errored: num(c.errored),
    }
  })
}

/** Sum token usage across all judge-model invocations in the run. */
export function extractUsage(runResponse: unknown): EvalUsage {
  const resp = (runResponse ?? {}) as Record<string, unknown>
  const usages = Array.isArray(resp.per_model_usage)
    ? (resp.per_model_usage as Array<Record<string, unknown>>)
    : []

  let tokensIn = 0
  let tokensOut = 0
  for (const u of usages) {
    tokensIn += num(u.prompt_tokens) || num(u.input_tokens)
    tokensOut += num(u.completion_tokens) || num(u.output_tokens)
  }
  return { tokensIn, tokensOut }
}

/**
 * Aggregate per-evaluator scores from the run's OUTPUT ITEMS (one item per data
 * row, each carrying a `results[]` with `{name, score, passed, status}`).
 *
 * This is the authoritative source: a *successful* run leaves the run object's
 * `per_testing_criteria_results` summary empty, so the run-level extractor finds
 * nothing — but the per-row output items always carry the scores. We mean the
 * numeric scores and tally pass/fail/errored counts so the gate engine has both
 * a score and counts to fall back on.
 */
export function extractScoresFromOutputItems(outputItemsResponse: unknown): EvalScore[] {
  const resp = (outputItemsResponse ?? {}) as Record<string, unknown>
  const items = Array.isArray(resp.data)
    ? (resp.data as Array<Record<string, unknown>>)
    : Array.isArray(resp)
      ? (resp as Array<Record<string, unknown>>)
      : []

  const acc = new Map<string, { scores: number[]; passed: number; failed: number; errored: number }>()
  for (const item of items) {
    const results = Array.isArray(item.results) ? (item.results as Array<Record<string, unknown>>) : []
    for (const r of results) {
      const evaluator = String(r.name ?? r.metric ?? r.evaluator ?? 'unknown')
      const entry = acc.get(evaluator) ?? { scores: [], passed: 0, failed: 0, errored: 0 }
      if (String(r.status ?? '') === 'error') {
        entry.errored += 1
      } else {
        const s = optNum(r.score)
        if (s !== null) entry.scores.push(s)
        if (r.passed === true) entry.passed += 1
        else if (r.passed === false) entry.failed += 1
      }
      acc.set(evaluator, entry)
    }
  }

  return [...acc.entries()].map(([evaluator, e]) => ({
    evaluator,
    score: e.scores.length > 0 ? e.scores.reduce((a, b) => a + b, 0) / e.scores.length : null,
    passed: e.passed,
    failed: e.failed,
    errored: e.errored,
  }))
}

/**
 * Walk an output-items response and collect distinct error messages. The
 * preview shape is unstable and nests errors in several places (item.error,
 * item.sample.error, item.results[].sample.error), so we deep-scan for any
 * `error` / `error_message` key carrying a string or `{ message }`.
 */
export function extractErrorSamples(outputItemsResponse: unknown, limit = 3): string[] {
  const out = new Set<string>()

  const visit = (node: unknown, depth: number): void => {
    if (node == null || depth > 8 || out.size >= limit) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1)
      return
    }
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if ((key === 'error' || key === 'error_message') && value != null) {
          if (typeof value === 'string' && value.trim()) {
            out.add(value.trim())
          } else if (
            typeof value === 'object' &&
            typeof (value as Record<string, unknown>).message === 'string'
          ) {
            out.add(String((value as Record<string, unknown>).message).trim())
          }
        }
        visit(value, depth + 1)
      }
    }
  }

  const resp = (outputItemsResponse ?? {}) as Record<string, unknown>
  visit(resp.data ?? resp, 0)
  return [...out].slice(0, limit)
}

/** Pull the human-facing report URL, if any. */
export function extractReportUrl(runResponse: unknown): string | undefined {
  const resp = (runResponse ?? {}) as Record<string, unknown>
  const url = resp.report_url ?? resp.reportUrl
  return typeof url === 'string' ? url : undefined
}
