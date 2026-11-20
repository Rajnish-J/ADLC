'use client'

// The AI summary of a finished run: its impact on the project (what changed, why it matters, what to review), and —
// when it failed — the likely cause and what to try next. Written the first time someone opens a finished run, then
// kept; marked out of date when the run's record changes, so anyone can rewrite it.

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw, Sparkles } from 'lucide-react'
import type { ProjectRunDetail, RunInsight } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { Markdown } from '@/components/common/markdown'
import { generateRunInsight } from '@/service/runs.service'

const ENDED = new Set(['completed', 'failed', 'cancelled', 'expired'])

export default function RunInsightCard({ projectKey, run }: { projectKey: string; run: ProjectRunDetail }) {
  const [insight, setInsight] = useState<RunInsight | null>(run.insight)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const asked = useRef(false)
  useEffect(() => setInsight(run.insight), [run.insight])

  const ended = ENDED.has(run.status)
  const enabled = insight?.enabled ?? false

  async function generate(force: boolean) {
    setBusy(true)
    setFailed(null)
    try {
      setInsight(await generateRunInsight(projectKey, run.id, force))
    } catch (err) {
      setFailed(err instanceof AppError ? err.message : 'Could not write the summary')
    } finally {
      setBusy(false)
    }
  }

  // First visit to a finished run: write its summary once.
  useEffect(() => {
    if (asked.current || !ended || !enabled || insight?.impact) return
    asked.current = true
    void generate(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, enabled, insight?.impact])

  return (
    <UI.Card className="gap-3">
      <UI.CardHeader>
        <UI.CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4 text-primary" /> AI summary
        </UI.CardTitle>
        <UI.CardDescription>
          {insight?.generatedAt
            ? `Written ${UI.relativeTime(insight.generatedAt)}${insight.model ? ` by ${insight.model}` : ''}, from this run’s record`
            : 'What the run changed and why it matters, from its steps, changes and gates'}
        </UI.CardDescription>
        {ended && enabled ? (
          <UI.CardAction>
            <UI.Button variant="ghost" size="sm" onClick={() => void generate(true)} disabled={busy}>
              {busy ? <UI.Spinner /> : <RefreshCw />} {insight?.impact ? 'Rewrite' : 'Write'}
            </UI.Button>
          </UI.CardAction>
        ) : null}
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-3 text-sm">
        {!enabled ? (
          <p className="text-muted-foreground">{insight?.reason ?? 'No model is configured for summaries.'}</p>
        ) : !ended ? (
          <p className="text-muted-foreground">The summary is written once the run ends.</p>
        ) : busy && !insight?.impact ? (
          <div className="flex flex-col gap-2" aria-busy>
            <UI.Skeleton className="h-4 w-11/12" />
            <UI.Skeleton className="h-4 w-10/12" />
            <UI.Skeleton className="h-4 w-8/12" />
          </div>
        ) : insight?.impact ? (
          <>
            {insight.stale ? (
              <UI.Badge variant="warning" className="self-start">
                The run changed since this was written
              </UI.Badge>
            ) : null}
            <Markdown source={insight.impact} className="text-sm" />
            {insight.failure ? (
              <UI.Alert variant="destructive">
                <AlertTriangle />
                <UI.AlertTitle>Why it failed</UI.AlertTitle>
                <UI.AlertDescription>
                  <Markdown source={insight.failure} className="text-sm" />
                </UI.AlertDescription>
              </UI.Alert>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">No summary yet.</p>
        )}
        {failed ? <UI.ErrorAlert message={failed} /> : null}
      </UI.CardContent>
    </UI.Card>
  )
}
