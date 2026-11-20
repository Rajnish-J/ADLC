'use client'

import { Globe, Monitor, Settings2 } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import type { AuditEntry } from '@sdlc/contracts'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DataTableColumnHeader } from '@/components/common/data-table/column-header'
import type { DataTableFeatures } from '@/components/common/data-table/features'
import { UserAvatar } from '@/components/common/user-avatar'
import { dateTime, relativeTime } from '@/utils/format'
import { describeActivity } from './activityText'

export const CLIENT_LABELS: Record<string, string> = { extension: 'VS Code', web: 'Web' }

function ClientBadge({ via }: { via: string }) {
  if (via === 'extension') {
    return (
      <Badge variant="secondary">
        <Monitor /> VS Code
      </Badge>
    )
  }
  if (via === 'web') {
    return (
      <Badge variant="outline">
        <Globe /> Web
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <Settings2 /> {via}
    </Badge>
  )
}

export const activityColumns: ColumnDef<DataTableFeatures, AuditEntry>[] = [
  {
    id: 'when',
    accessorFn: (e) => e.createdAt,
    header: ({ column }) => <DataTableColumnHeader column={column} title="When" />,
    cell: ({ row }) => (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="whitespace-nowrap text-muted-foreground">{relativeTime(row.original.createdAt)}</span>
        </TooltipTrigger>
        <TooltipContent>{dateTime(row.original.createdAt)}</TooltipContent>
      </Tooltip>
    ),
  },
  {
    id: 'actor',
    accessorFn: (e) => e.actor?.displayName ?? 'System',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Who" />,
    cell: ({ row }) => {
      const name = row.original.actor?.displayName ?? 'System'
      return (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <UserAvatar name={name} />
          {name}
        </span>
      )
    },
  },
  {
    id: 'activity',
    accessorFn: (e) => describeActivity(e),
    header: ({ column }) => <DataTableColumnHeader column={column} title="Activity" />,
    cell: ({ row }) => <span className="text-foreground/90">{describeActivity(row.original)}</span>,
    enableHiding: false,
  },
  {
    id: 'client',
    accessorFn: (e) => e.via,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Client" />,
    cell: ({ row }) => <ClientBadge via={row.original.via} />,
  },
]
