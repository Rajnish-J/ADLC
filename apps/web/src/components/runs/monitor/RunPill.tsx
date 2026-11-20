'use client'

// The minimized run: a small card in the bottom-right of every page while one of your runs is active — what it is,
// where it is ("Implement — Step 2 of 6") — that takes you back to the run page on click. It hides on that run's own
// page. Closing it hides that run's pill for the browser session, until the run needs you (waits for approval).
// Independent of the Agent map dock: it sits beside the dock, never under it. Desktop only; phones keep the
// dock's floating "N runs" button.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Maximize2, Workflow, X } from 'lucide-react'
import { runProgress, type RunMapStatus } from '@sdlc/core'
import type { ActiveRun } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { useSession } from '@/components/providers/SessionProvider'
import { runHref } from '@/components/work/RunComposerProvider'
import { Dot, runTitle } from './RunMonitor'
import { useRunMonitor, type RunRef } from './RunMonitorProvider'
import { useActiveRuns, useFollowedRun } from './useRunMonitorData'

const DISMISSED_KEY = 'sdlc.runPill.dismissed'

/** runId → the run's status when its pill was closed. */
type Dismissed = Record<string, string>

function readDismissed(): Dismissed {
  try {
    return JSON.parse(window.sessionStorage.getItem(DISMISSED_KEY) ?? '{}') as Dismissed
  } catch {
    return {}
  }
}

function writeDismissed(d: Dismissed): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(d))
  } catch {
    /* private window: closing just isn't remembered across reloads */
  }
}

/** A closed pill comes back when its run starts waiting on you. */
function isDismissed(run: ActiveRun, dismissed: Dismissed): boolean {
  const at = dismissed[run.runId]
  if (at === undefined) return false
  return !(run.status === 'awaiting_approval' && at !== 'awaiting_approval')
}

const ACTIVITY: Record<RunMapStatus, string> = {
  running: 'In progress',
  waiting: 'Waiting for approval',
  queued: 'Queued in VS Code',
  pending: 'Waiting for VS Code',
  done: 'Finishing',
  failed: 'Stopped',
  skipped: 'In progress',
}

export function RunPill() {
  const { me } = useSession()
  const pathname = usePathname()
  const router = useRouter()
  const { open: dockOpen, followed } = useRunMonitor()
  const active = useActiveRuns(Boolean(me))
  const [dismissed, setDismissed] = useState<Dismissed>({})
  useEffect(() => setDismissed(readDismissed()), [])

  const runs = active.data ?? []
  const visible = runs.filter((r) => !isDismissed(r, dismissed))
  // The run the dock follows, else the newest one still showing.
  const run = visible.find((r) => r.runId === followed?.runId) ?? visible[0] ?? null
  const href = run ? runHref(run.projectKey, run.runId) : null
  const onRunPage = !!href && decodeURIComponent(pathname) === decodeURIComponent(href)
  const shown = !!me && !!run && !onRunPage

  // Only load the run's map while the pill is on screen.
  const ref: RunRef | null = useMemo(() => (shown && run ? { projectKey: run.projectKey, runId: run.runId } : null), [shown, run?.projectKey, run?.runId])
  const { map } = useFollowedRun(ref)

  const dismiss = useCallback(() => {
    if (!run) return
    setDismissed((prev) => {
      const next = { ...prev, [run.runId]: run.status }
      // Forget runs that have ended.
      for (const id of Object.keys(next)) if (!runs.some((r) => r.runId === id)) delete next[id]
      writeDismissed(next)
      return next
    })
  }, [run, runs])

  if (!shown || !run || !href) return null

  const progress = map ? runProgress(map) : null
  const state: RunMapStatus = progress?.state ?? (run.status === 'awaiting_approval' ? 'waiting' : run.status === 'running' ? 'running' : 'pending')
  const what = state === 'waiting' ? ACTIVITY.waiting : (progress?.label ?? ACTIVITY[state])
  const step = progress && progress.total > 0 ? `Step ${Math.max(progress.index, 1)} of ${progress.total}` : null
  const others = runs.length - 1
  const open = () => router.push(href)

  return (
    <div
      role="status"
      aria-live="polite"
      className={UI.cn(
        'fixed bottom-4 z-40 hidden w-[320px] items-center gap-3 rounded-xl border bg-card py-2.5 pr-2 pl-2.5 text-card-foreground shadow-lg md:flex',
        'animate-in fade-in slide-in-from-bottom-2',
        // Beside the dock (open: 340px panel; closed: 44px rail), never under it.
        dockOpen ? 'right-[356px]' : 'right-[60px]',
      )}
    >
      <button type="button" onClick={open} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Open the run">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Workflow className="size-4" />
          <Dot status={state} className="absolute -top-0.5 -right-0.5 ring-2 ring-card" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{runTitle(run)}</span>
            {others > 0 ? (
              <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary" title={`${others} more active run${others === 1 ? '' : 's'}`}>
                +{others}
              </span>
            ) : null}
          </span>
          <span className={UI.cn('truncate text-xs', state === 'waiting' ? 'text-warning-foreground dark:text-warning' : 'text-muted-foreground')}>
            {what}
            {step ? ` — ${step}` : ''}
          </span>
        </span>
      </button>
      <span className="flex shrink-0 items-center">
        <UI.Tooltip>
          <UI.TooltipTrigger asChild>
            <UI.Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={open} aria-label="Open the run">
              <Maximize2 />
            </UI.Button>
          </UI.TooltipTrigger>
          <UI.TooltipContent>Open the run</UI.TooltipContent>
        </UI.Tooltip>
        <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
        <UI.Tooltip>
          <UI.TooltipTrigger asChild>
            <UI.Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={dismiss} aria-label="Hide this run">
              <X />
            </UI.Button>
          </UI.TooltipTrigger>
          <UI.TooltipContent>Hide — it comes back if the run needs you</UI.TooltipContent>
        </UI.Tooltip>
      </span>
    </div>
  )
}
