'use client'

// Where the run's time went: each step on one time axis — the agent working, the run waiting on people (an approval
// step, or a plan waiting for its approval), gates — with the totals; and the tools the harness called, per tool and
// per step, failed calls included (tool detail comes from harness hooks, so Claude Code runs have it).

import { useMemo } from 'react'
import { AlertTriangle, Hammer } from 'lucide-react'
import type { ProjectRunDetail, RunEvent } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { useRunEvents } from '@/hooks/work/useHarnessRuns'
import { formatDuration, plural } from './runFormat'
import { runTimeline, type SegmentKind } from './runTimeline'

const SEGMENT: Record<SegmentKind, { label: string; className: string }> = {
  agent: { label: 'Agent working', className: 'bg-chart-1' },
  waiting: { label: 'Waiting on people', className: 'bg-chart-4' },
  gate: { label: 'Gate', className: 'bg-chart-3' },
  other: { label: 'Other', className: 'bg-muted-foreground/60' },
}

function Gantt({ run, events }: { run: ProjectRunDetail; events: RunEvent[] }) {
  const tl = useMemo(() => runTimeline(run, events), [run, events])
  const span = Math.max(1, tl.end - tl.start)
  const pos = (t: number) => `${((t - tl.start) / span) * 100}%`
  const width = (a: number, b: number) => `${Math.max(0.4, ((b - a) / span) * 100)}%`
  const kinds = (Object.keys(SEGMENT) as SegmentKind[]).filter((k) => tl.totals[k] > 0)

  return (
    <UI.Card className="gap-4">
      <UI.CardHeader>
        <UI.CardTitle className="text-base">Timeline</UI.CardTitle>
        <UI.CardDescription>
          {formatDuration(span)} in all
          {tl.totals.agent ? ` · agents working ${formatDuration(tl.totals.agent)}` : ''}
          {tl.totals.waiting ? ` · waiting on people ${formatDuration(tl.totals.waiting)}` : ''}
        </UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-3">
        {tl.rows.length === 0 ? <p className="text-sm text-muted-foreground">No steps have started yet.</p> : null}
        <ul className="flex flex-col gap-2">
          {tl.rows.map((r) => (
            <li key={r.stepId} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_4.5rem] items-center gap-3 text-sm">
              <span className="truncate" title={r.agentName ? `${r.label} · ${r.agentName}` : r.label}>
                {r.label}
              </span>
              <span className="relative h-4 rounded-sm bg-muted/60" aria-label={`${r.label}: ${formatDuration(r.end - r.start)}`}>
                {r.segments.map((s, i) => (
                  <UI.Tooltip key={i}>
                    <UI.TooltipTrigger asChild>
                      <span
                        className={UI.cn('absolute inset-y-0.5 rounded-[3px]', SEGMENT[s.kind].className, r.status === 'running' && 'animate-pulse')}
                        style={{ left: pos(s.start), width: width(s.start, s.end) }}
                      />
                    </UI.TooltipTrigger>
                    <UI.TooltipContent>
                      {SEGMENT[s.kind].label} · {formatDuration(s.end - s.start)}
                    </UI.TooltipContent>
                  </UI.Tooltip>
                ))}
              </span>
              <span className="text-right text-xs text-muted-foreground tabular-nums">{formatDuration(r.end - r.start)}</span>
            </li>
          ))}
        </ul>
        {kinds.length ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {kinds.map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className={UI.cn('size-2.5 rounded-sm', SEGMENT[k].className)} aria-hidden />
                {SEGMENT[k].label} · {formatDuration(tl.totals[k])}
              </span>
            ))}
          </div>
        ) : null}
      </UI.CardContent>
    </UI.Card>
  )
}

function Tools({ run, events }: { run: ProjectRunDetail; events: RunEvent[] }) {
  const calls = events.filter((e) => e.type === 'tool.called' || e.type === 'tool.failed')
  const byTool = useMemo(() => {
    const m = new Map<string, { ok: number; failed: number }>()
    for (const e of calls) {
      const t = m.get(e.tool ?? 'unknown') ?? { ok: 0, failed: 0 }
      if (e.type === 'tool.failed') t.failed++
      else t.ok++
      m.set(e.tool ?? 'unknown', t)
    }
    return [...m.entries()].sort((a, b) => b[1].ok + b[1].failed - (a[1].ok + a[1].failed))
  }, [calls])
  const failed = calls.filter((e) => e.type === 'tool.failed')
  const stepLabel = new Map(run.steps.map((s) => [s.stepId, s.label]))
  const max = byTool[0] ? byTool[0][1].ok + byTool[0][1].failed : 1

  return (
    <UI.Card className="gap-4">
      <UI.CardHeader>
        <UI.CardTitle className="flex items-center gap-2 text-base">
          <Hammer className="size-4 text-muted-foreground" /> Tool calls
        </UI.CardTitle>
        <UI.CardDescription>
          {calls.length ? `${plural(calls.length, 'call')}${failed.length ? ` · ${failed.length} failed` : ''}` : 'No tool calls were reported.'}
        </UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-4">
        {calls.length === 0 ? (
          <p className="text-sm text-muted-foreground">Tool detail comes from the harness’s hooks — Claude Code reports every call; other harnesses report only their steps.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {byTool.map(([tool, n]) => (
              <li key={tool} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
                <span className="truncate font-mono text-xs" title={tool}>
                  {tool}
                </span>
                <span className="flex h-2 gap-0.5" aria-hidden>
                  <span className="rounded-sm bg-chart-2" style={{ width: `${(n.ok / max) * 100}%` }} />
                  {n.failed ? <span className="rounded-sm bg-destructive" style={{ width: `${(n.failed / max) * 100}%` }} /> : null}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {n.ok + n.failed}
                  {n.failed ? <span className="text-destructive"> · {n.failed} failed</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {failed.length ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <AlertTriangle className="size-4 text-destructive" /> Failed calls
            </h3>
            <ul className="flex flex-col gap-1 text-xs">
              {failed.slice(0, 30).map((e) => (
                <li key={e.seq} className="flex min-w-0 gap-2">
                  <span className="shrink-0 font-mono">{e.tool}</span>
                  <span className="truncate text-muted-foreground" title={e.path ?? e.summary ?? ''}>
                    {e.path ?? e.summary ?? ''}
                  </span>
                  {e.stepId ? <span className="ml-auto shrink-0 text-muted-foreground">{stepLabel.get(e.stepId) ?? ''}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </UI.CardContent>
    </UI.Card>
  )
}

export default function RunTimelinePanel({ projectKey, run }: { projectKey: string; run: ProjectRunDetail }) {
  const { data, error } = useRunEvents(projectKey, run.id)
  const events = data?.events ?? []
  return (
    <div className="flex flex-col gap-4">
      {error ? <UI.ErrorAlert message={error.message} /> : null}
      <Gantt run={run} events={events} />
      <Tools run={run} events={events} />
    </div>
  )
}
