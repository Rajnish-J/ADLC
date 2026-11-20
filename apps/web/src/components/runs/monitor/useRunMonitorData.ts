'use client'

// The data behind the run monitor: my active runs, and for the followed one its record, its activity (fetched
// incrementally — only events after the last seen seq) and its workflow, folded into the agent map. Live: every run
// event refetches only what changed, and a clock ticks the elapsed times while something is running.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildRunMap, type RunMap } from '@sdlc/core'
import type { ActiveRun, PlatformEvent, ProjectRunDetail, RunEvent, WorkflowDetail } from '@sdlc/contracts'
import { useLiveEvents } from '@/components/providers/LiveEventsProvider'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { getWorkflow } from '@/service/catalog.service'
import { listActiveRuns, listRunEvents } from '@/service/harnessRun.service'
import { getRunDetail } from '@/service/runs.service'
import type { RunRef } from './RunMonitorProvider'

const runEvent = (e: PlatformEvent): boolean =>
  e.type === 'run.requested' || e.type === 'run.step' || (e.type === 'work.changed' && e.kind === 'run') || e.type === 'run.activity'

/** My runs that have not ended. Only refetched when a run starts, changes state or reports its first activity. */
export function useActiveRuns(enabled: boolean): ApiResource<ActiveRun[]> {
  return useApiResource(() => (enabled ? listActiveRuns() : Promise.resolve([])), [enabled], (e) => runEvent(e) && e.type !== 'run.activity')
}

/** A run's activity, loaded once and then only what is new. */
function useRunEventLog(run: RunRef | null): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([])
  const last = useRef(-1)
  const key = run ? `${run.projectKey}/${run.runId}` : ''
  const loading = useRef(false)
  const again = useRef(false)

  const load = useCallback(async () => {
    if (!run) return
    if (loading.current) {
      again.current = true
      return
    }
    loading.current = true
    try {
      const page = await listRunEvents(run.projectKey, run.runId, last.current)
      if (page.events.length) {
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.seq))
          return [...prev, ...page.events.filter((e) => !seen.has(e.seq))].slice(-2_000)
        })
      }
      last.current = Math.max(last.current, page.lastSeq)
    } catch {
      /* the next event retries */
    } finally {
      loading.current = false
      if (again.current) {
        again.current = false
        void load()
      }
    }
    // `run` is identified by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    setEvents([])
    last.current = -1
    void load()
  }, [load])

  useLiveEvents((e) => {
    if (run && e.type === 'run.activity' && e.runId === run.runId && e.lastSeq > last.current) void load()
  })
  return events
}

/** Ticks every second while `active` (elapsed times). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return active ? now : Date.now()
}

export interface FollowedRun {
  detail: ProjectRunDetail | null
  map: RunMap | null
  /** The run's workflow (its current version), for drawing the flow; null for quick fixes or while loading. */
  spec: WorkflowDetail['spec'] | null
  error: string | null
  reload: () => Promise<void>
}

export function useFollowedRun(run: RunRef | null): FollowedRun {
  const detail = useApiResource(
    () => (run ? getRunDetail(run.projectKey, run.runId) : Promise.resolve(null)),
    [run?.projectKey, run?.runId],
    (e) => !!run && ((e.type === 'work.changed' && e.kind === 'run' && e.runId === run.runId) || (e.type === 'run.activity' && e.runId === run.runId)),
  )
  const events = useRunEventLog(run)
  const workflowId = detail.data?.workflowId ?? null
  const workflow = useApiResource<WorkflowDetail | null>(
    () => (run && workflowId ? getWorkflow(run.projectKey, workflowId).catch(() => null) : Promise.resolve(null)),
    [run?.projectKey, workflowId],
  )
  const d = detail.data
  const live = !!d && ['requested', 'queued', 'running', 'awaiting_approval'].includes(d.status)
  const now = useNow(live)
  const map = useMemo(() => {
    if (!d) return null
    const spec = workflow.data?.spec.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label })) ?? null
    return buildRunMap(
      { ...d, engine: d.engine },
      d.steps.map((s) => ({ ...s, nodeId: s.nodeId ?? null })),
      events,
      spec,
      now,
    )
  }, [d, events, workflow.data, now])
  return { detail: d, map, spec: workflow.data?.spec ?? null, error: detail.error?.message ?? null, reload: detail.reload }
}
