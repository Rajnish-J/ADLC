'use client'

import Link from 'next/link'
import type { ColumnDef } from '@tanstack/react-table'
import { ArrowDownToLine, ArrowUpFromLine, ThumbsDown, ThumbsUp, Zap } from 'lucide-react'
import { harnessLabel, RUN_KIND_LABELS, RUN_STATUS_LABELS, type ProjectRun } from '@sdlc/contracts'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTableColumnHeader } from '@/components/common/data-table/column-header'
import type { DataTableFeatures } from '@/components/common/data-table/features'
import { UserAvatar } from '@/components/common/user-avatar'
import { RUN_VARIANT, runDuration } from '@/components/work/RunSteps'
import { dateTime, relativeTime } from '@/utils/format'

/** A thin added / removed bar, scaled to a few hundred lines so small and large changes both read. */
function DeltaBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  if (!total) return null
  const width = Math.min(100, 12 + Math.log10(total + 1) * 30)
  return (
    <span className="flex h-1.5 gap-0.5 overflow-hidden" style={{ width: `${width}%` }} aria-hidden>
      {additions ? <span className="h-full rounded-sm bg-success" style={{ flexGrow: additions }} /> : null}
      {deletions ? <span className="h-full rounded-sm bg-destructive" style={{ flexGrow: deletions }} /> : null}
    </span>
  )
}

export const runColumns: ColumnDef<DataTableFeatures, ProjectRun>[] = [
  {
    id: 'workflow',
    accessorFn: (r) =>
      `${r.workflowName} ${r.story ? `${r.story.key}-${r.story.number} ${r.story.title}` : ''} ${r.task ? `${r.task.key} ${r.task.title}` : ''} ${r.prompt ?? ''} ${r.branch ?? ''}`,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Run" />,
    cell: ({ row }) => {
      const { workflowName, story, task, prompt, kind, iteration } = row.original
      return (
        <div className="flex max-w-[22rem] min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {story ? (
              <Link
                href={`/projects/${story.key}/stories/${story.number}`}
                onClick={(e) => e.stopPropagation()}
                className="truncate font-medium hover:text-primary hover:underline"
              >
                {task ? `${task.key} · ${task.title}` : `${story.key}-${story.number} · ${story.title}`}
              </Link>
            ) : (
              <span className="flex min-w-0 items-center gap-1 font-medium" title={prompt ?? undefined}>
                <Zap className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{prompt?.split('\n')[0] || 'Quick fix'}</span>
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              {RUN_KIND_LABELS[kind]}
              {iteration ? ` · #${iteration}` : ''}
            </Badge>
            <span className="truncate">{workflowName}</span>
          </span>
        </div>
      )
    },
    enableHiding: false,
  },
  {
    id: 'status',
    accessorFn: (r) => RUN_STATUS_LABELS[r.status],
    header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
    cell: ({ row }) => (
      <Badge variant={RUN_VARIANT[row.original.status]}>
        {row.original.status === 'running' ? <Spinner className="size-3" /> : null}
        {RUN_STATUS_LABELS[row.original.status]}
      </Badge>
    ),
  },
  {
    id: 'changes',
    accessorFn: (r) => r.additions + r.deletions + r.filesChanged / 1000,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Changes" />,
    cell: ({ row }) => {
      const { filesChanged, additions, deletions } = row.original
      if (!filesChanged) return <span className="text-muted-foreground">—</span>
      return (
        <span className="flex w-28 flex-col gap-1 whitespace-nowrap">
          <span className="text-xs">
            {filesChanged} file{filesChanged === 1 ? '' : 's'}{' '}
            {additions + deletions ? (
              <span className="text-muted-foreground tabular-nums">
                <span className="text-success">+{additions}</span> <span className="text-destructive">−{deletions}</span>
              </span>
            ) : null}
          </span>
          <DeltaBar additions={additions} deletions={deletions} />
        </span>
      )
    },
  },
  {
    id: 'memory',
    accessorFn: (r) => r.memoryUsed + r.memoryWritten,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Memory" />,
    cell: ({ row }) => {
      const { memoryUsed, memoryWritten } = row.original
      if (!memoryUsed && !memoryWritten) return <span className="text-muted-foreground">—</span>
      return (
        <span className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          <span className="inline-flex items-center gap-0.5" title={`${memoryUsed} memory item${memoryUsed === 1 ? '' : 's'} given to the agents`}>
            <ArrowDownToLine className="size-3.5" /> {memoryUsed} used
          </span>
          <span className="inline-flex items-center gap-0.5" title={`${memoryWritten} memory item${memoryWritten === 1 ? '' : 's'} written by the run`}>
            <ArrowUpFromLine className="size-3.5" /> {memoryWritten} written
          </span>
        </span>
      )
    },
  },
  {
    id: 'gates',
    accessorFn: (r) => r.gatesFailed * 1000 + r.gatesPassed,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Gates & feedback" />,
    cell: ({ row }) => {
      const { gatesPassed, gatesFailed, feedback } = row.original
      if (gatesPassed + gatesFailed + feedback.up + feedback.down === 0) return <span className="text-muted-foreground">—</span>
      return (
        <span className="flex flex-wrap items-center gap-1">
          {gatesPassed ? <Badge variant="success">{gatesPassed} passed</Badge> : null}
          {gatesFailed ? <Badge variant="destructive">{gatesFailed} failed</Badge> : null}
          {feedback.up ? (
            <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" title="Thumbs up">
              <ThumbsUp className="size-3.5" /> {feedback.up}
            </span>
          ) : null}
          {feedback.down ? (
            <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" title="Thumbs down">
              <ThumbsDown className="size-3.5" /> {feedback.down}
            </span>
          ) : null}
        </span>
      )
    },
  },
  {
    id: 'harness',
    accessorFn: (r) => (r.engine ? harnessLabel(r.engine) : 'Built-in'),
    header: ({ column }) => <DataTableColumnHeader column={column} title="Harness" />,
    cell: ({ row }) => {
      const { engine, engineModel, origin } = row.original
      return (
        <span className="flex flex-col whitespace-nowrap">
          <span>{engine ? harnessLabel(engine) : 'Built-in'}</span>
          <span className="text-xs text-muted-foreground">{engineModel ?? (origin === 'web' ? 'started from the web' : 'started in VS Code')}</span>
        </span>
      )
    },
  },
  {
    id: 'who',
    accessorFn: (r) => r.startedBy?.displayName ?? 'Someone',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Who" />,
    cell: ({ row }) => {
      const name = row.original.startedBy?.displayName ?? 'Someone'
      return (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <UserAvatar name={name} />
          {name}
        </span>
      )
    },
  },
  {
    id: 'started',
    accessorFn: (r) => r.startedAt,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Started" />,
    cell: ({ row }) => (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="whitespace-nowrap text-muted-foreground">
            {relativeTime(row.original.startedAt)} · {runDuration(row.original.startedAt, row.original.finishedAt)}
          </span>
        </TooltipTrigger>
        <TooltipContent>{dateTime(row.original.startedAt)}</TooltipContent>
      </Tooltip>
    ),
  },
]
