'use client'

// The run monitor: a dock on the right of every page that follows one of your workflow runs live — the
// orchestrator, each agent step it handed to your VS Code (agent, harness, time, tokens, what it is doing right now,
// the subagents it spawned), any approval it waits on, and where it is in the workflow. Collapsed, it is a slim rail
// that pulses while runs are active. On phones it opens as a sheet.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Bot, ChevronDown, ChevronRight, ExternalLink, FileCode2, PanelRightClose, Square, Workflow, Wrench } from 'lucide-react'
import { formatElapsed, formatTokens, type RunMap, type RunMapFlowNode, type RunMapNode, type RunMapStatus } from '@sdlc/core'
import { harnessLabel, type ActiveRun, type ProjectRunDetail } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { useSession } from '@/components/providers/SessionProvider'
import { useIsMobile } from '@/hooks/use-mobile'
import ApprovalPanel from '@/components/runs/ApprovalPanel'
import { runHref } from '@/components/work/RunComposerProvider'
import { cancelRun } from '@/service/harnessRun.service'
import { useRunMonitor, type RunRef } from './RunMonitorProvider'
import { useActiveRuns, useFollowedRun } from './useRunMonitorData'

const DOT: Record<RunMapStatus, string> = {
  running: 'bg-sky-500 animate-pulse',
  waiting: 'bg-amber-500 animate-pulse',
  queued: 'bg-violet-400',
  pending: 'bg-muted-foreground/40',
  done: 'bg-emerald-500',
  failed: 'bg-destructive',
  skipped: 'bg-muted-foreground/30',
}

const STATUS_LABEL: Record<RunMapStatus, string> = {
  running: 'Working',
  waiting: 'Waiting for you',
  queued: 'Queued',
  pending: 'Waiting for VS Code',
  done: 'Done',
  failed: 'Stopped',
  skipped: 'Skipped',
}

export function Dot({ status, className }: { status: RunMapStatus; className?: string }) {
  return <span aria-hidden className={UI.cn('inline-block size-2 shrink-0 rounded-full', DOT[status], className)} />
}

export function runTitle(r: Pick<ActiveRun, 'projectKey' | 'storyNumber' | 'prompt' | 'workflowName'>): string {
  if (r.storyNumber != null) return `${r.projectKey}-${r.storyNumber}`
  const p = r.prompt?.trim()
  return p ? `Quick fix: ${p.length > 40 ? `${p.slice(0, 40)}…` : p}` : r.workflowName
}

// ─── The dock ────────────────────────────────────────────────────────────────────────────────────

export function RunMonitorDock() {
  const { me } = useSession()
  const { open, setOpen, followed, follow } = useRunMonitor()
  const isMobile = useIsMobile()
  const active = useActiveRuns(Boolean(me))
  const runs = active.data ?? []
  // The followed run, else the newest active one.
  const current: RunRef | null = followed ?? (runs[0] ? { projectKey: runs[0].projectKey, runId: runs[0].runId } : null)
  const working = runs.filter((r) => r.status !== 'requested').length

  if (!me) return null
  if (!open) {
    if (runs.length === 0) return null
    return (
      <>
        <aside className="sticky top-0 hidden h-svh w-11 shrink-0 flex-col items-center gap-2 border-l bg-sidebar py-3 md:flex">
          <UI.Tooltip>
            <UI.TooltipTrigger asChild>
              <UI.Button variant="ghost" size="icon" className="relative" onClick={() => setOpen(true)} aria-label="Open the run monitor">
                <Workflow />
                <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
                  {runs.length}
                </span>
              </UI.Button>
            </UI.TooltipTrigger>
            <UI.TooltipContent side="left">
              {runs.length} active run{runs.length === 1 ? '' : 's'} — open the agent map
            </UI.TooltipContent>
          </UI.Tooltip>
          {working > 0 ? <Dot status="running" /> : null}
        </aside>
        <MobileButton count={runs.length} onClick={() => setOpen(true)} />
      </>
    )
  }

  const body = <MonitorBody runs={runs} current={current} onPick={follow} onClose={() => setOpen(false)} />
  return (
    <>
      <aside className="sticky top-0 hidden h-svh w-[340px] shrink-0 flex-col border-l bg-sidebar md:flex" aria-label="Run monitor">
        {body}
      </aside>
      {/* Phones only. Mounted on desktop, the modal sheet's backdrop would blur and block the whole page even with
          its panel hidden. */}
      {isMobile ? (
        <UI.Sheet open onOpenChange={(o) => !o && setOpen(false)}>
          <UI.SheetContent side="right" className="w-full p-0 md:hidden">
            <UI.SheetHeader className="sr-only">
              <UI.SheetTitle>Run monitor</UI.SheetTitle>
              <UI.SheetDescription>What your workflow runs are doing right now.</UI.SheetDescription>
            </UI.SheetHeader>
            {body}
          </UI.SheetContent>
        </UI.Sheet>
      ) : null}
    </>
  )
}

function MobileButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <UI.Button className="fixed right-4 bottom-20 z-40 rounded-full shadow-lg md:hidden" size="sm" onClick={onClick}>
      <Workflow /> {count} run{count === 1 ? '' : 's'}
    </UI.Button>
  )
}

function MonitorBody({ runs, current, onPick, onClose }: { runs: ActiveRun[]; current: RunRef | null; onPick: (r: RunRef) => void; onClose: () => void }) {
  const followed = useFollowedRun(current)
  const { detail, map } = followed
  // The followed run stays listed after it ends, until another one is picked.
  const options = useMemo(() => {
    const list = runs.map((r) => ({ value: r.runId, projectKey: r.projectKey, label: runTitle(r), status: r.status }))
    if (current && detail && !list.some((o) => o.value === current.runId)) {
      list.unshift({ value: current.runId, projectKey: current.projectKey, label: runTitle({ ...detail, projectKey: current.projectKey, storyNumber: detail.story?.number ?? null, prompt: detail.prompt ?? null }), status: detail.status })
    }
    return list
  }, [runs, current, detail])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Workflow className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Agent map</p>
          <p className="truncate text-xs text-muted-foreground">
            {map ? `${map.nodes.filter((n) => n.kind === 'agent').length} agent step${map.nodes.filter((n) => n.kind === 'agent').length === 1 ? '' : 's'} · click one for details` : 'Your workflow runs, live'}
          </p>
        </div>
        <UI.Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Collapse the run monitor">
          <PanelRightClose />
        </UI.Button>
      </div>

      {options.length > 1 ? (
        <div className="border-b px-3 py-2">
          <UI.Select
            value={current?.runId}
            onValueChange={(id) => {
              const o = options.find((x) => x.value === id)
              if (o) onPick({ projectKey: o.projectKey, runId: o.value })
            }}
          >
            <UI.SelectTrigger size="sm" className="w-full" aria-label="Run to follow">
              <UI.SelectValue placeholder="Pick a run" />
            </UI.SelectTrigger>
            <UI.SelectContent>
              {options.map((o) => (
                <UI.SelectItem key={o.value} value={o.value}>
                  {o.label} · {o.status.replace('_', ' ')}
                </UI.SelectItem>
              ))}
            </UI.SelectContent>
          </UI.Select>
        </div>
      ) : null}

      <UI.ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          {!current ? (
            <p className="px-1 py-8 text-center text-sm text-muted-foreground">No runs right now. Start one with Quick run (Ctrl K) or from a story.</p>
          ) : followed.error ? (
            <UI.ErrorAlert message={followed.error} />
          ) : !detail || !map ? (
            <div className="flex flex-col gap-2">
              <UI.Skeleton className="h-16" />
              <UI.Skeleton className="ml-5 h-14" />
              <UI.Skeleton className="ml-5 h-14" />
            </div>
          ) : (
            <>
              <AgentMap map={map} run={detail} projectKey={current.projectKey} />
              {detail.pendingApproval && detail.status === 'awaiting_approval' ? (
                <ApprovalPanel projectKey={current.projectKey} run={detail} pending={detail.pendingApproval} canDecide onDecided={() => void followed.reload()} />
              ) : null}
              {map.flow.length ? <FlowStrip flow={map.flow} /> : null}
              <RunFooter projectKey={current.projectKey} run={detail} map={map} />
            </>
          )}
        </div>
      </UI.ScrollArea>
    </div>
  )
}

// ─── The map: orchestrator → steps → subagents ───────────────────────────────────────────────────

function AgentMap({ map, run, projectKey }: { map: RunMap; run: ProjectRunDetail; projectKey: string }) {
  const o = map.orchestrator
  const steps = map.nodes.filter((n) => n.kind !== 'trigger')
  return (
    <div className="flex flex-col">
      <div className="rounded-lg border bg-card px-3 py-2.5 shadow-xs">
        <div className="flex items-center gap-2">
          <Dot status={o.status} />
          <span className="truncate text-sm font-medium">Orchestrator · {o.label}</span>
        </div>
        <p className="mt-0.5 pl-4 text-xs text-muted-foreground">
          {run.story ? `${run.story.key} · ` : ''}
          {STATUS_LABEL[o.status]} · {formatElapsed(o.elapsedMs)}
          {o.tokens !== null ? ` · ${formatTokens(o.tokens)} tokens` : ''}
        </p>
        {o.activity ? <p className="mt-1 line-clamp-2 pl-4 text-xs text-foreground/80">{o.activity}</p> : null}
      </div>
      {steps.length ? (
        <ul className="relative mt-2 ml-3 flex flex-col gap-2 border-l pl-4">
          {steps.map((n) => (
            <StepCard key={n.stepId} node={n} current={n.nodeId === map.currentNodeId} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 ml-7 text-xs text-muted-foreground">No step has started yet.</p>
      )}
    </div>
  )
}

function StepCard({ node, current }: { node: RunMapNode; current: boolean }) {
  const [open, setOpen] = useState(false)
  const title = node.kind === 'agent' ? (node.agentName ?? node.label) : node.label
  const kind = node.kind === 'agent' ? node.label : node.kind === 'gate' ? 'Quality gate' : node.kind === 'approval' ? 'Approval' : node.kind
  return (
    <li className="relative">
      <span aria-hidden className="absolute top-4 -left-4 h-px w-4 bg-border" />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={UI.cn(
          'w-full rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/50',
          current && 'border-primary/50 ring-1 ring-primary/20',
        )}
      >
        <div className="flex items-center gap-2">
          <Dot status={node.status} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
          {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
        </div>
        <p className="mt-0.5 truncate pl-4 text-xs text-muted-foreground">
          {kind}
          {node.harness ? ` · ${harnessLabel(node.harness)}` : ''} · {formatElapsed(node.elapsedMs)}
          {node.tokens !== null ? ` · ${formatTokens(node.tokens)} tokens` : ''}
        </p>
        {node.lastActivity && (node.status === 'running' || node.status === 'waiting' || open) ? (
          <p className="mt-1 truncate pl-4 text-xs text-foreground/80" title={node.lastActivity}>
            {node.lastActivity}
          </p>
        ) : null}
      </button>
      {open ? <StepDetail node={node} /> : null}
      {node.subAgents.length ? (
        <ul className="mt-1.5 ml-3 flex flex-col gap-1 border-l pl-3">
          {node.subAgents.map((a, i) => (
            <li key={`${a.name}-${i}`} className="relative flex items-center gap-2 text-xs">
              <span aria-hidden className="absolute top-2 -left-3 h-px w-3 bg-border" />
              <Dot status={a.status === 'running' ? 'running' : 'done'} className="size-1.5" />
              <Bot className="size-3 text-muted-foreground" />
              <span className="truncate">{a.name}</span>
              <span className="ml-auto text-muted-foreground">{formatElapsed(a.elapsedMs)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function StepDetail({ node }: { node: RunMapNode }) {
  return (
    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs">
      <span className="flex items-center gap-1 text-muted-foreground">
        <Wrench className="size-3" /> Tool calls
      </span>
      <span>{node.toolCalls}</span>
      <span className="flex items-center gap-1 text-muted-foreground">
        <FileCode2 className="size-3" /> Files
      </span>
      <span>{node.files}</span>
      <span className="text-muted-foreground">Status</span>
      <span>{STATUS_LABEL[node.status]}</span>
      {node.skills.length ? (
        <>
          <span className="text-muted-foreground">Skills</span>
          <span className="truncate" title={node.skills.join(', ')}>
            {node.skills.join(', ')}
          </span>
        </>
      ) : null}
    </div>
  )
}

// ─── Where the run is in the workflow ────────────────────────────────────────────────────────────

function FlowStrip({ flow }: { flow: RunMapFlowNode[] }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Workflow</p>
      <ol className="flex flex-col">
        {flow.map((n, i) => (
          <li key={n.nodeId} className="flex items-stretch gap-2.5">
            <div className="flex w-2 flex-col items-center">
              <Dot status={n.state} className="mt-1.5" />
              {i < flow.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
            </div>
            <span
              className={UI.cn(
                'pb-2 text-xs',
                n.state === 'running' || n.state === 'waiting' ? 'font-medium text-foreground' : n.state === 'pending' ? 'text-muted-foreground' : 'text-foreground/80',
              )}
            >
              {n.label}
              {n.state === 'waiting' ? ' — waiting for you' : n.state === 'running' ? ' — in progress' : n.state === 'failed' ? ' — stopped' : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function RunFooter({ projectKey, run, map }: { projectKey: string; run: ProjectRunDetail; map: RunMap }) {
  const [stopping, setStopping] = useState(false)
  const live = ['requested', 'queued', 'running', 'awaiting_approval'].includes(run.status)
  async function stop() {
    setStopping(true)
    try {
      await cancelRun(projectKey, run.id)
      UI.toast.success('Run stopped')
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not stop the run')
    } finally {
      setStopping(false)
    }
  }
  return (
    <div className="flex items-center gap-2 border-t pt-3">
      <UI.Button variant="outline" size="sm" asChild>
        <Link href={runHref(projectKey, run.id)}>
          <ExternalLink /> Open run
        </Link>
      </UI.Button>
      {map.nodes.some((n) => n.files > 0) ? (
        <UI.Button variant="ghost" size="sm" asChild>
          <Link href={`/projects/${encodeURIComponent(projectKey)}/code?run=${encodeURIComponent(run.id)}`}>
            <FileCode2 /> Changes
          </Link>
        </UI.Button>
      ) : null}
      {live ? (
        <UI.Button variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive" onClick={() => void stop()} disabled={stopping}>
          {stopping ? <UI.Spinner /> : <Square />} Stop
        </UI.Button>
      ) : null}
    </div>
  )
}
