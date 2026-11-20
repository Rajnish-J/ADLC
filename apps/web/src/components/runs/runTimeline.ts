// A run's time, step by step: when each step ran, and how much of it was the agent working versus the run waiting on
// people (approval steps, and the wait between an agent submitting its plan and someone deciding on it). Pure.

import type { ProjectRunDetail, RunEvent } from '@sdlc/contracts'

export type SegmentKind = 'agent' | 'waiting' | 'gate' | 'other'

export interface TimelineSegment {
  kind: SegmentKind
  start: number
  end: number
}

export interface TimelineRow {
  stepId: string
  label: string
  stepKind: string
  agentName: string | null
  status: string
  start: number
  end: number
  segments: TimelineSegment[]
}

export interface RunTimeline {
  start: number
  end: number
  rows: TimelineRow[]
  totals: Record<SegmentKind, number>
}

const t = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null)

/** Plan submitted → decided, per step, from the run's activity. */
function approvalWaits(events: RunEvent[]): Map<string, { start: number; end: number | null }[]> {
  const out = new Map<string, { start: number; end: number | null }[]>()
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!e.stepId) continue
    const list = out.get(e.stepId) ?? []
    if (e.type === 'plan.submitted' || e.type === 'approval.requested') {
      if (!list.some((w) => w.end === null)) list.push({ start: Date.parse(e.at), end: null })
    } else if (e.type === 'approval.decided') {
      const open = list.find((w) => w.end === null)
      if (open) open.end = Date.parse(e.at)
    }
    out.set(e.stepId, list)
  }
  return out
}

export function runTimeline(run: Pick<ProjectRunDetail, 'steps' | 'startedAt' | 'finishedAt'>, events: RunEvent[] = [], now = Date.now()): RunTimeline {
  const runStart = Date.parse(run.startedAt)
  const runEnd = t(run.finishedAt) ?? now
  const waits = approvalWaits(events)
  const totals: Record<SegmentKind, number> = { agent: 0, waiting: 0, gate: 0, other: 0 }
  const rows: TimelineRow[] = []

  for (const s of [...run.steps].sort((a, b) => a.seq - b.seq)) {
    const start = t(s.startedAt)
    if (start === null) continue
    const end = t(s.finishedAt) ?? (s.status === 'running' ? runEnd : start)
    const base: SegmentKind = s.kind === 'agent' ? 'agent' : s.kind === 'approval' ? 'waiting' : s.kind === 'gate' ? 'gate' : 'other'
    let segments: TimelineSegment[] = [{ kind: base, start, end }]
    if (s.kind === 'agent') {
      // Cut the plan-approval waits out of the agent's own time.
      const cuts = (waits.get(s.stepId) ?? []).map((w) => ({ start: Math.max(start, w.start), end: Math.min(end, w.end ?? end) })).filter((w) => w.end > w.start)
      if (cuts.length) {
        segments = []
        let cursor = start
        for (const c of cuts.sort((a, b) => a.start - b.start)) {
          if (c.start > cursor) segments.push({ kind: 'agent', start: cursor, end: c.start })
          segments.push({ kind: 'waiting', start: c.start, end: c.end })
          cursor = Math.max(cursor, c.end)
        }
        if (end > cursor) segments.push({ kind: 'agent', start: cursor, end })
      }
    }
    for (const seg of segments) totals[seg.kind] += Math.max(0, seg.end - seg.start)
    rows.push({ stepId: s.stepId, label: s.label, stepKind: s.kind, agentName: s.agentName, status: s.status, start, end, segments })
  }
  const end = Math.max(runEnd, ...rows.map((r) => r.end))
  return { start: Math.min(runStart, ...rows.map((r) => r.start)), end, rows, totals }
}
