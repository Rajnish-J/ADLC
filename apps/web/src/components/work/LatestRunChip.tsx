'use client'

// Which workflow a story or task was last worked with, and how that run is going. Stories aren't mapped to a
// workflow ahead of time — it's picked when the run starts — so the latest run is where the board learns it.

import Link from 'next/link'
import { Workflow } from 'lucide-react'
import { harnessLabel, RUN_STATUS_LABELS, type RunSummary, type StoryRunStatus } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { runHref } from './RunComposerProvider'
import { RUN_VARIANT } from './RunSteps'

const ACTIVE = new Set(['requested', 'queued', 'running', 'awaiting_approval'])

function describe(run: RunSummary): string {
  const status = RUN_STATUS_LABELS[run.status as StoryRunStatus] ?? run.status
  const where = run.engine ? harnessLabel(run.engine) : 'the built-in runtime'
  return `${run.workflowName ?? 'Workflow'} — ${status.toLowerCase()} in ${where}, started ${new Date(run.startedAt).toLocaleString()}`
}

/** On a board card: the workflow's name with a dot for the run's state (the card itself opens the story). */
export function LatestRunTag({ run }: { run: RunSummary | null }) {
  if (!run?.workflowName) return null
  const active = ACTIVE.has(run.status)
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 text-xs text-muted-foreground" title={describe(run)}>
      <Workflow className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{run.workflowName}</span>
      <span
        className={UI.cn(
          'size-1.5 shrink-0 rounded-full',
          active ? 'animate-pulse bg-primary' : run.status === 'completed' ? 'bg-success' : run.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/50',
        )}
        aria-label={RUN_STATUS_LABELS[run.status as StoryRunStatus] ?? run.status}
      />
    </span>
  )
}

/** On a story page or task row: the workflow, the run's state and harness, linking to the run's page. */
export function LatestRunChip({ projectKey, run }: { projectKey: string; run: RunSummary | null }) {
  if (!run) return null
  return (
    <Link href={runHref(projectKey, run.id)} className="inline-flex items-center gap-1 hover:underline" title={describe(run)}>
      {run.workflowName ? (
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <Workflow className="size-3" aria-hidden />
          {run.workflowName}
        </span>
      ) : null}
      <UI.Badge variant={RUN_VARIANT[run.status as StoryRunStatus] ?? 'outline'}>{RUN_STATUS_LABELS[run.status as StoryRunStatus] ?? run.status}</UI.Badge>
      {run.engine ? harnessLabel(run.engine) : 'Built-in'} · {UI.relativeTime(run.startedAt)}
    </Link>
  )
}
