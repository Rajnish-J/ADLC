'use client'

// The top of a run's page: what it worked on, its status and attempt (with the runs either side), the facts (harness,
// who, when, how long, branch, workflow) and what you can do — run it again, compare it with the previous attempt,
// open its branch in VS Code, copy it as a PR description or download a report, cancel it while it runs.

import Link from 'next/link'
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FileText, GitBranch, GitCompare, Link2, RotateCcw, Square, Zap } from 'lucide-react'
import { harnessLabel, RUN_KIND_LABELS, RUN_STATUS_LABELS, runOpenLink, type ProjectRunDetail } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { quickRunHref, runHref } from '@/components/work/RunComposerProvider'
import { RUN_VARIANT, runDuration } from '@/components/work/RunSteps'
import { downloadText, runReportMarkdown, runTitle } from '@/lib/runReport'
import { cancelRun } from '@/service/harnessRun.service'

const ACTIVE = new Set(['requested', 'queued', 'running', 'awaiting_approval'])

function openExternal(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    UI.toast.success(`${what} copied`)
  } catch {
    UI.toast.error('Could not copy to the clipboard')
  }
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm">{children}</dd>
    </div>
  )
}

export default function RunHeader({ projectKey, run, onCompare }: { projectKey: string; run: ProjectRunDetail; onCompare: () => void }) {
  const branch = run.changes?.branch ?? run.branch
  const pageUrl = typeof window === 'undefined' ? '' : window.location.href
  const again = quickRunHref(projectKey, {
    prompt: run.prompt ?? undefined,
    storyNumber: run.story?.number ?? null,
    taskNumber: run.task?.number ?? null,
    workflowId: run.workflowId,
    harness: run.engine,
  })

  async function cancel() {
    try {
      const r = await cancelRun(projectKey, run.id)
      UI.toast.success(r.delivered ? 'Asked VS Code to cancel the run' : 'Run cancelled')
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not cancel the run')
    }
  }

  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <UI.Badge variant={RUN_VARIANT[run.status]}>
              {run.status === 'running' ? <UI.Spinner className="size-3" /> : null}
              {RUN_STATUS_LABELS[run.status]}
            </UI.Badge>
            <UI.Badge variant="outline">
              {run.kind === 'quick' ? <Zap /> : null}
              {RUN_KIND_LABELS[run.kind]}
            </UI.Badge>
            {run.attempt ? (
              <span className="inline-flex items-center gap-0.5">
                <UI.Button variant="ghost" size="icon-xs" disabled={!run.attempt.previousId} asChild={Boolean(run.attempt.previousId)} aria-label="Previous attempt">
                  {run.attempt.previousId ? (
                    <Link href={runHref(projectKey, run.attempt.previousId)}>
                      <ChevronLeft />
                    </Link>
                  ) : (
                    <ChevronLeft />
                  )}
                </UI.Button>
                Attempt {run.attempt.number} of {run.attempt.total}
                <UI.Button variant="ghost" size="icon-xs" disabled={!run.attempt.nextId} asChild={Boolean(run.attempt.nextId)} aria-label="Next attempt">
                  {run.attempt.nextId ? (
                    <Link href={runHref(projectKey, run.attempt.nextId)}>
                      <ChevronRight />
                    </Link>
                  ) : (
                    <ChevronRight />
                  )}
                </UI.Button>
              </span>
            ) : null}
            <span className="font-mono">{run.id.slice(0, 8)}</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-balance">
            {run.story ? (
              <Link href={`/projects/${run.story.key}/stories/${run.story.number}`} className="hover:text-primary hover:underline">
                {runTitle(run)}
              </Link>
            ) : (
              runTitle(run)
            )}
          </h1>
          {run.prompt && run.story ? <p className="text-sm whitespace-pre-wrap text-muted-foreground">“{run.prompt}”</p> : null}
          {run.prompt && !run.story && run.prompt.includes('\n') ? <p className="text-sm whitespace-pre-wrap text-muted-foreground">{run.prompt}</p> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {ACTIVE.has(run.status) ? (
            <UI.Button variant="outline" size="sm" onClick={() => void cancel()}>
              <Square /> Cancel run
            </UI.Button>
          ) : null}
          <UI.Button variant="outline" size="sm" asChild>
            <Link href={again}>
              <RotateCcw /> Run again
            </Link>
          </UI.Button>
          {run.attempt?.previousId ? (
            <UI.Button variant="outline" size="sm" onClick={onCompare}>
              <GitCompare /> Compare
            </UI.Button>
          ) : null}
          {branch ? (
            <UI.Button variant="outline" size="sm" onClick={() => openExternal(runOpenLink(run.id, projectKey))} title={`Check out ${branch} in VS Code`}>
              <ExternalLink /> Open in VS Code
            </UI.Button>
          ) : null}
          <UI.DropdownMenu>
            <UI.DropdownMenuTrigger asChild>
              <UI.Button size="sm">
                <FileText /> Report
              </UI.Button>
            </UI.DropdownMenuTrigger>
            <UI.DropdownMenuContent align="end">
              <UI.DropdownMenuItem onSelect={() => void copy(runReportMarkdown(run, pageUrl), 'PR description')}>
                <Copy /> Copy as PR description
              </UI.DropdownMenuItem>
              <UI.DropdownMenuItem onSelect={() => downloadText(`run-${run.id.slice(0, 8)}.md`, runReportMarkdown(run, pageUrl), 'text/markdown')}>
                <Download /> Download report (.md)
              </UI.DropdownMenuItem>
              <UI.DropdownMenuSeparator />
              <UI.DropdownMenuItem onSelect={() => void copy(pageUrl, 'Link')}>
                <Link2 /> Copy link to this run
              </UI.DropdownMenuItem>
            </UI.DropdownMenuContent>
          </UI.DropdownMenu>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border bg-muted/30 p-4 @3xl/main:grid-cols-3 @5xl/main:grid-cols-6">
        <Fact label="Harness">{run.engine ? `${harnessLabel(run.engine)}${run.engineModel ? ` · ${run.engineModel}` : ''}` : 'Built-in runtime'}</Fact>
        <Fact label="Started by">
          <span className="inline-flex items-center gap-1.5">
            <UI.UserAvatar name={run.startedBy?.displayName ?? 'Someone'} />
            {run.startedBy?.displayName ?? 'Someone'}
          </span>
        </Fact>
        <Fact label="Started">
          <span title={UI.dateTime(run.startedAt)}>
            {UI.relativeTime(run.startedAt)} · {run.origin === 'web' ? 'from the web' : 'in VS Code'}
          </span>
        </Fact>
        <Fact label="Duration">{runDuration(run.startedAt, run.finishedAt)}</Fact>
        <Fact label="Branch">
          {branch ? (
            <span className="inline-flex min-w-0 items-center gap-1 font-mono text-xs" title={branch}>
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate">{branch}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Not reported yet</span>
          )}
        </Fact>
        <Fact label="Workflow">
          {run.workflowName}
          {run.workflowVersion ? <span className="text-muted-foreground"> · v{run.workflowVersion}</span> : null}
        </Fact>
      </dl>
    </header>
  )
}
