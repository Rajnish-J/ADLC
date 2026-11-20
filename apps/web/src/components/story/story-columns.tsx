'use client'

// Story table columns, shared by the board's list view and "My stories".

import { CircleAlert } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import { STORY_STATUSES, type Story } from '@sdlc/contracts'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTableColumnHeader } from '@/components/common/data-table/column-header'
import type { DataTableFeatures } from '@/components/common/data-table/features'
import { PriorityBadge, StatusBadge } from '@/components/common/story-badges'
import { UserAvatar } from '@/components/common/user-avatar'
import { dateTime, relativeTime } from '@/utils/format'
import { PRIORITY_ORDER } from '@/utils/status'
import { StoryExternalBadge } from './StoryExternalBadge'

type StoryColumn = ColumnDef<DataTableFeatures, Story>

export function storyColumns({ withProject = false }: { withProject?: boolean } = {}): StoryColumn[] {
  const columns: StoryColumn[] = [
    {
      id: 'key',
      accessorFn: (s) => s.number,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Key" />,
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-xs font-semibold text-muted-foreground">{row.original.key}</span>
          <StoryExternalBadge story={row.original} />
        </span>
      ),
      enableHiding: false,
    },
    {
      id: 'title',
      accessorFn: (s) => `${s.key} ${s.title}`,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Title" />,
      cell: ({ row }) => (
        <div className="flex max-w-[28rem] items-center gap-2">
          <span className="truncate font-medium">{row.original.title}</span>
          {row.original.isBlocked ? <CircleAlert className="size-4 shrink-0 text-destructive" aria-label="Blocked" /> : null}
        </div>
      ),
      enableHiding: false,
    },
    {
      id: 'status',
      accessorFn: (s) => STORY_STATUSES.indexOf(s.status),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: 'priority',
      accessorFn: (s) => PRIORITY_ORDER[s.priority],
      header: ({ column }) => <DataTableColumnHeader column={column} title="Priority" />,
      cell: ({ row }) => <PriorityBadge priority={row.original.priority} />,
    },
    {
      id: 'assignee',
      accessorFn: (s) => s.assignee?.displayName ?? '',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Assignee" />,
      cell: ({ row }) =>
        row.original.assignee ? (
          <span className="flex items-center gap-2">
            <UserAvatar name={row.original.assignee.displayName} />
            <span className="truncate">{row.original.assignee.displayName}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        ),
    },
    {
      id: 'criteria',
      accessorFn: (s) => (s.acceptanceCriteria.length ? s.acceptanceCriteria.filter((c) => c.met).length / s.acceptanceCriteria.length : -1),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Criteria" />,
      cell: ({ row }) => {
        const all = row.original.acceptanceCriteria
        return all.length ? (
          <span className="tabular-nums text-muted-foreground">
            {all.filter((c) => c.met).length}/{all.length}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
    {
      id: 'updated',
      accessorFn: (s) => s.updatedAt,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Updated" />,
      cell: ({ row }) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground">{relativeTime(row.original.updatedAt)}</span>
          </TooltipTrigger>
          <TooltipContent>{dateTime(row.original.updatedAt)}</TooltipContent>
        </Tooltip>
      ),
    },
  ]
  if (withProject) {
    columns.splice(1, 0, {
      id: 'project',
      accessorFn: (s) => s.projectKey,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Project" />,
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.projectKey}</span>,
    })
  }
  return columns
}
