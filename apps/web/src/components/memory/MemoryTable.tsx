'use client'

// Memory as a table (every tab of the Memory page): kind, title with a one-line preview, where it came from, how
// often runs were given it, who and when — sortable, paged, with column visibility. A row opens the item's
// details; its ⋯ menu has the item's options. Proposals also get inline Accept / Reject.

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Check, Pin, X } from 'lucide-react'
import type { MemoryItem } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { MemoryActionsMenu, type MemoryActions } from './MemoryActions'
import { KIND_META, profileHeadline, profileVersionOf, SOURCE_LABEL } from './memory-meta'

export type MemoryTableVariant = 'project' | 'proposals' | 'stories' | 'archived'

const preview = (m: MemoryItem): string => (profileVersionOf(m) !== null ? profileHeadline(m.content) : m.content.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim())

function KindCell({ item }: { item: MemoryItem }) {
  const version = profileVersionOf(item)
  if (version !== null) return <UI.Badge>Profile · v{version}</UI.Badge>
  const meta = KIND_META[item.kind]
  return <UI.Badge variant={meta.variant}>{meta.label}</UI.Badge>
}

function columns(projectKey: string, variant: MemoryTableVariant, actions: MemoryActions, onView: (m: MemoryItem) => void): ColumnDef<UI.DataTableFeatures, MemoryItem>[] {
  const key = encodeURIComponent(projectKey)
  const storyLink = (m: MemoryItem) =>
    m.storyKey ? (
      <Link href={`/projects/${key}/stories/${m.storyNumber}?tab=memory`} onClick={(e) => e.stopPropagation()} className="font-mono text-xs text-primary hover:underline" title={m.storyTitle ?? undefined}>
        {m.storyKey}
      </Link>
    ) : null

  const cols: Array<ColumnDef<UI.DataTableFeatures, MemoryItem> | false> = [
    variant === 'stories' && {
      id: 'story',
      accessorFn: (m) => m.storyNumber ?? 0,
      header: ({ column }) => <UI.DataTableColumnHeader column={column} title="Story" />,
      cell: ({ row }) => storyLink(row.original),
    },
    {
      id: 'kind',
      accessorFn: (m) => (profileVersionOf(m) !== null ? 'profile' : m.kind),
      header: ({ column }) => <UI.DataTableColumnHeader column={column} title="Kind" />,
      cell: ({ row }) => <KindCell item={row.original} />,
    },
    {
      id: 'title',
      accessorFn: (m) => `${m.title} ${m.content}`,
      header: ({ column }) => <UI.DataTableColumnHeader column={column} title="Title" />,
      cell: ({ row }) => {
        const m = row.original
        return (
          <div className="flex max-w-xl min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 font-medium">
              {m.pinned ? <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" /> : null}
              <span className="truncate">{m.title}</span>
            </span>
            <span className="line-clamp-1 text-xs text-muted-foreground">{preview(m)}</span>
          </div>
        )
      },
    },
    (variant === 'proposals' || variant === 'archived') && {
      id: 'status',
      accessorFn: (m) => m.status,
      header: ({ column }) => <UI.DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => {
        const m = row.original
        const badge = m.status === 'proposed' ? <UI.Badge variant="warning">Proposed</UI.Badge> : <UI.Badge variant="outline">{m.status === 'rejected' ? 'Rejected' : 'Archived'}</UI.Badge>
        return m.decisionComment ? (
          <span className="flex flex-col gap-0.5">
            {badge}
            <span className="line-clamp-1 max-w-48 text-xs text-muted-foreground" title={m.decisionComment}>
              “{m.decisionComment}”
            </span>
          </span>
        ) : (
          badge
        )
      },
    },
    variant !== 'stories' && {
      id: 'source',
      accessorFn: (m) => (m.runId ? 'run' : m.source),
      header: ({ column }) => <UI.DataTableColumnHeader column={column} title="Source" />,
      cell: ({ row }) => {
        const m = row.original
        const label = m.runId ? (
          <Link href={`/projects/${key}/workflow/runs/${m.runId}`} onClick={(e) => e.stopPropagation()} className="text-xs text-primary hover:underline">
            Agent run
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">{SOURCE_LABEL[m.source] ?? 'Manual'}</span>
        )
        return (
          <span className="flex flex-col gap-0.5">
            {label}
            {storyLink(m)}
          </span>
        )
      },
    },
    variant === 'stories' && {
      id: 'promotion',
      accessorFn: (m) => m.promotion?.status ?? '',
      header: 'In project memory',
      cell: ({ row }) => {
        const p = row.original.promotion
        if (!p) return <span className="text-xs text-muted-foreground">—</span>
        return <UI.Badge variant={p.status === 'accepted' ? 'success' : p.status === 'proposed' ? 'warning' : 'outline'}>{p.status === 'accepted' ? 'Yes' : p.status === 'proposed' ? 'Proposed' : 'Not accepted'}</UI.Badge>
      },
    },
    variant !== 'archived' && {
      id: 'used',
      accessorFn: (m) => m.usedByRuns,
      header: ({ column }) => <UI.DataTableColumnHeader column={column} title="Runs" />,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground tabular-nums" title="Agent runs that were given this item">
          {row.original.usedByRuns || '—'}
        </span>
      ),
    },
    {
      id: 'author',
      accessorFn: (m) => m.author?.displayName ?? 'Platform',
      header: ({ column }) => <UI.DataTableColumnHeader column={column} title="By" />,
      cell: ({ row }) => <span className="text-xs">{row.original.author?.displayName ?? 'Platform'}</span>,
    },
    {
      id: 'when',
      accessorFn: (m) => (variant === 'archived' ? m.updatedAt : m.createdAt),
      header: ({ column }) => <UI.DataTableColumnHeader column={column} title={variant === 'archived' ? 'Archived' : 'When'} />,
      cell: ({ row }) => {
        const at = variant === 'archived' ? row.original.updatedAt : row.original.createdAt
        return (
          <span className="text-xs whitespace-nowrap text-muted-foreground" title={UI.dateTime(at)}>
            {UI.relativeTime(at)}
          </span>
        )
      },
    },
    {
      id: 'actions',
      enableHiding: false,
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const m = row.original
        return (
          <div className="flex items-center justify-end gap-1">
            {variant === 'proposals' && m.actions.canDecide ? (
              <>
                <UI.Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Accept ${m.title}`}
                  title="Accept"
                  disabled={actions.busy}
                  onClick={(e) => {
                    e.stopPropagation()
                    actions.accept(m)
                  }}
                >
                  <Check className="text-success" />
                </UI.Button>
                <UI.Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Reject ${m.title}`}
                  title="Reject"
                  disabled={actions.busy}
                  onClick={(e) => {
                    e.stopPropagation()
                    actions.reject(m)
                  }}
                >
                  <X className="text-destructive" />
                </UI.Button>
              </>
            ) : null}
            <MemoryActionsMenu item={m} actions={actions} onView={onView} />
          </div>
        )
      },
    },
  ]
  return cols.filter((c): c is ColumnDef<UI.DataTableFeatures, MemoryItem> => Boolean(c))
}

interface Props {
  items: MemoryItem[]
  projectKey: string
  variant: MemoryTableVariant
  actions: MemoryActions
  onView: (item: MemoryItem) => void
  /** Filter controls above the table; with them the table's own search box is hidden (they search the server). */
  toolbar?: ReactNode
  emptyMessage: string
  /** Keep the order the items come in (search relevance, pinned first) instead of sorting by date. */
  keepOrder?: boolean
}

export default function MemoryTable({ items, projectKey, variant, actions, onView, toolbar, emptyMessage, keepOrder }: Props) {
  return (
    <UI.DataTable
      columns={columns(projectKey, variant, actions, onView)}
      data={items}
      searchColumn={toolbar ? undefined : 'title'}
      searchPlaceholder={variant === 'stories' ? 'Search story memory' : 'Search'}
      toolbar={toolbar}
      onRowClick={onView}
      emptyMessage={emptyMessage}
      initialSorting={keepOrder ? [] : [{ id: 'when', desc: true }]}
    />
  )
}
