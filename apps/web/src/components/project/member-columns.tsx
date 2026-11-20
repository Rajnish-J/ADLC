'use client'

// Members table columns: who, role (editable within the roles you may grant), when they joined, and remove.

import { useState } from 'react'
import { MoreHorizontal, UserMinus } from 'lucide-react'
import { toast } from 'sonner'
import type { ColumnDef } from '@tanstack/react-table'
import { PROJECT_ROLE_LABELS, PROJECT_ROLES, type Member, type ProjectDetail, type ProjectRole } from '@sdlc/contracts'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DataTableColumnHeader } from '@/components/common/data-table/column-header'
import type { DataTableFeatures } from '@/components/common/data-table/features'
import { UserAvatar } from '@/components/common/user-avatar'
import { AppError } from '@/appError'
import { changeMemberRole, removeMember } from '@/service/project.service'
import { relativeTime } from '@/utils/format'
import { ROLE_VARIANT } from '@/utils/status'

type OnChange = (project: ProjectDetail) => void

function RoleCell({ member, project, onChange }: { member: Member; project: ProjectDetail; onChange: OnChange }) {
  const editable = project.permissions.includes('project.manage_members') && project.assignableRoles.includes(member.role)
  if (!editable) return <Badge variant={ROLE_VARIANT[member.role]}>{PROJECT_ROLE_LABELS[member.role]}</Badge>
  return (
    <Select
      value={member.role}
      onValueChange={(value) => {
        const role = value as ProjectRole
        changeMemberRole(project.key, member.user.id, role)
          .then((p) => {
            onChange(p)
            toast.success(`${member.user.displayName} is now ${PROJECT_ROLE_LABELS[role]}`)
          })
          .catch((err) => toast.error(err instanceof AppError ? err.message : 'Could not change the role.'))
      }}
    >
      <SelectTrigger size="sm" className="w-36" aria-label={`Role of ${member.user.displayName}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {project.assignableRoles.map((r) => (
          <SelectItem key={r} value={r}>
            {PROJECT_ROLE_LABELS[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function RemoveAction({ member, project, onChange }: { member: Member; project: ProjectDetail; onChange: OnChange }) {
  const [confirming, setConfirming] = useState(false)
  const removable = project.permissions.includes('project.manage_members') && project.assignableRoles.includes(member.role)
  if (!removable) return null

  async function remove(): Promise<void> {
    try {
      onChange(await removeMember(project.key, member.user.id))
      toast.success(`${member.user.displayName} removed from ${project.key}`)
    } catch (err) {
      toast.error(err instanceof AppError ? err.message : 'Could not remove the member.')
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${member.user.displayName}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            <UserMinus /> Remove from project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {member.user.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose access to {project.key}. Stories assigned to them stay assigned until someone reassigns them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function memberColumns(project: ProjectDetail, onChange: OnChange): ColumnDef<DataTableFeatures, Member>[] {
  return [
    {
      id: 'member',
      accessorFn: (m) => `${m.user.displayName} ${m.user.email}`,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Member" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-3">
          <UserAvatar name={row.original.user.displayName} className="size-8" />
          <div className="min-w-0">
            <p className="truncate font-medium">{row.original.user.displayName}</p>
            <p className="truncate text-xs text-muted-foreground">{row.original.user.email}</p>
          </div>
        </div>
      ),
      enableHiding: false,
    },
    {
      id: 'role',
      accessorFn: (m) => PROJECT_ROLES.indexOf(m.role),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
      cell: ({ row }) => <RoleCell member={row.original} project={project} onChange={onChange} />,
    },
    {
      id: 'added',
      accessorFn: (m) => m.addedAt,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Added" />,
      cell: ({ row }) => <span className="text-muted-foreground">{relativeTime(row.original.addedAt)}</span>,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <RemoveAction member={row.original} project={project} onChange={onChange} />
        </div>
      ),
      enableSorting: false,
      enableHiding: false,
    },
  ]
}
