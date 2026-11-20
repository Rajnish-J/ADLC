'use client'

// Agent workflow runs started on the story (they execute in the developer's VS Code and are reported live).
// Each expands to its step timeline: gate results with evaluator scores, approval decisions, outputs and the
// files agents changed.

import Link from 'next/link'
import { ArrowUpRight, ChevronRight, Pause } from 'lucide-react'
import { RUN_STATUS_LABELS, type StoryRun } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import RunSteps, { RUN_VARIANT, runDuration } from './RunSteps'

export { RUN_VARIANT } from './RunSteps'

/** `projectKey` links each run to its own page (changes, memory, impact). */
export default function RunList({ runs, projectKey }: { runs: StoryRun[]; projectKey?: string }) {
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">No agent runs yet. Runs started on this story in VS Code appear here live.</p>
  return (
    <div className="divide-y rounded-xl border">
      {runs.map((run) => {
        const active = run.status === 'running' || run.status === 'awaiting_approval'
        return (
          <UI.Collapsible key={run.id} defaultOpen={active} className="group/run">
            <UI.CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/50">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/run:rotate-90" />
              <span className="min-w-0 flex-1 truncate font-medium">{run.workflowName}</span>
              <UI.Badge variant={RUN_VARIANT[run.status]}>
                {run.status === 'running' ? <UI.Spinner className="size-3" /> : null}
                {RUN_STATUS_LABELS[run.status]}
              </UI.Badge>
              <span className="hidden shrink-0 text-xs text-muted-foreground @xl/main:inline" title={UI.dateTime(run.startedAt)}>
                {run.startedBy?.displayName ?? 'Someone'} · {UI.relativeTime(run.startedAt)} · {runDuration(run.startedAt, run.finishedAt)}
              </span>
            </UI.CollapsibleTrigger>
            <UI.CollapsibleContent className="flex flex-col gap-3 border-t bg-muted/20 px-4 py-3 pl-11">
              {run.pendingApproval ? (
                <UI.Alert>
                  <Pause />
                  <UI.AlertTitle>Waiting for approval</UI.AlertTitle>
                  <UI.AlertDescription>{run.pendingApproval.question} — decided in VS Code.</UI.AlertDescription>
                </UI.Alert>
              ) : null}
              {run.error ? <UI.ErrorAlert title="Run failed" message={run.error} /> : null}
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {run.tokensIn + run.tokensOut > 0 ? `${(run.tokensIn + run.tokensOut).toLocaleString()} tokens · ` : ''}
                  {run.changedFiles.length} file{run.changedFiles.length === 1 ? '' : 's'} changed by agents
                </span>
                {projectKey ? (
                  <Link href={`/projects/${encodeURIComponent(projectKey)}/workflow/runs/${encodeURIComponent(run.id)}`} className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
                    Open run <ArrowUpRight className="size-3.5" />
                  </Link>
                ) : null}
              </p>
              <RunSteps steps={run.steps} />
            </UI.CollapsibleContent>
          </UI.Collapsible>
        )
      })}
    </div>
  )
}
