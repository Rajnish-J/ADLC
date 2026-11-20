'use client'

// The evaluator scores behind a governance gate's verdict: each evaluator's score against the threshold the
// gate policy set, pass/fail, and a link to the full evaluation report when the run produced one.

import { ExternalLink } from 'lucide-react'
import type { EvaluationResult } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'

const fmt = (n: number | null): string => (n === null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(2))

/** Scores are 0–1 for most evaluators and 1–5 for the Likert-style ones; scale the bar to whichever applies. */
function percent(score: number, threshold: number | null): number {
  const max = Math.max(score, threshold ?? 0) > 1 ? 5 : 1
  return Math.max(0, Math.min(100, (score / max) * 100))
}

export default function EvaluationScores({ evaluations, reportUrl }: { evaluations: EvaluationResult[]; reportUrl: string | null }) {
  if (evaluations.length === 0 && !reportUrl) return null
  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-background p-2">
      {evaluations.map((e) => (
        <div key={e.evaluator} className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-center gap-3 text-xs">
          <span className="truncate" title={e.evaluator}>
            {e.evaluator}
          </span>
          {e.score === null ? (
            <span className="text-muted-foreground">no score</span>
          ) : (
            <UI.Progress
              value={percent(e.score, e.threshold)}
              className={UI.cn('h-1.5', e.pass ? '[&>*]:bg-success' : '[&>*]:bg-destructive')}
              aria-label={`${e.evaluator} score`}
            />
          )}
          <span className="flex items-center gap-1.5 whitespace-nowrap tabular-nums">
            <span className="text-muted-foreground">
              {fmt(e.score)} / {fmt(e.threshold)}
            </span>
            <UI.Badge variant={e.pass ? 'success' : 'destructive'}>{e.pass ? 'Pass' : 'Fail'}</UI.Badge>
          </span>
        </div>
      ))}
      {reportUrl ? (
        <a href={reportUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-start text-xs text-primary hover:underline">
          Full evaluation report <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  )
}
