'use client'

// The run's workflow drawn as a live flow at the top of the run page: each step lights up as it runs, waits on you,
// finishes or stops, and the view follows the current step. Fed by the same live data as the Agent map dock (SSE, no
// polling). Quick fixes and runs whose workflow is gone have no flow to draw, so the card hides itself.

import { useMemo } from 'react'
import { Workflow } from 'lucide-react'
import { formatElapsed, runProgress, type RunMapStatus } from '@sdlc/core'
import * as UI from '@/imports/UI.imports'
import WorkflowCanvas from '@/components/catalog/WorkflowCanvas'
import { useFollowedRun } from './monitor/useRunMonitorData'

const STATE_LABEL: Record<RunMapStatus, string> = {
  running: 'In progress',
  waiting: 'Waiting for you',
  queued: 'Queued',
  pending: 'Waiting for VS Code',
  done: 'Done',
  failed: 'Stopped',
  skipped: 'Skipped',
}

const STATE_BADGE: Partial<Record<RunMapStatus, 'default' | 'secondary' | 'destructive' | 'outline'>> = {
  running: 'default',
  failed: 'destructive',
  done: 'secondary',
}

export default function RunFlowCard({ projectKey, runId }: { projectKey: string; runId: string }) {
  const ref = useMemo(() => ({ projectKey, runId }), [projectKey, runId])
  const { map, spec } = useFollowedRun(ref)
  const status = useMemo(() => (map ? Object.fromEntries(map.flow.map((n) => [n.nodeId, n.state])) : undefined), [map])

  if (!map || !spec) return null
  const progress = runProgress(map)
  const runState = map.orchestrator.status
  const live = runState === 'running' || runState === 'waiting' || runState === 'queued' || runState === 'pending'

  return (
    <UI.Card className="gap-0 overflow-hidden py-0">
      <UI.CardHeader className="border-b py-3">
        <UI.CardTitle className="flex items-center gap-2 text-base">
          <Workflow className="size-4 text-primary" /> Flow
        </UI.CardTitle>
        <UI.CardDescription className="truncate">
          {progress.total > 0 ? `Step ${progress.index} of ${progress.total}` : map.orchestrator.label}
          {live && progress.label ? ` · ${progress.label}` : ''}
          {live && map.orchestrator.activity ? ` — ${map.orchestrator.activity}` : ''}
        </UI.CardDescription>
        <UI.CardAction className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">{formatElapsed(map.orchestrator.elapsedMs)}</span>
          <UI.Badge variant={STATE_BADGE[runState] ?? 'outline'}>{STATE_LABEL[runState]}</UI.Badge>
        </UI.CardAction>
      </UI.CardHeader>
      <WorkflowCanvas spec={spec} status={status} focusNodeId={live ? map.currentNodeId : null} className="h-[320px]" />
    </UI.Card>
  )
}
