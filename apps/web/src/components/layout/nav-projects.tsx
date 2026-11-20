'use client'

// sidebar-07's project list: every project you can see, with its ready-to-pick-up count and quick actions.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { KanbanSquare, Link2, MoreHorizontal, Trash2, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import type { ProjectSummary } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { useSession } from '@/components/providers/SessionProvider'
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
import { archiveProject } from '@/service/settings.service'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'

export function NavProjects({ projects, currentKey, onChanged }: { projects: ProjectSummary[]; currentKey: string | undefined; onChanged?: () => void }) {
  const { isMobile } = useSidebar()
  const router = useRouter()
  const { me } = useSession()
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)
  if (projects.length === 0) return null

  // Owners and org admins may delete (archive) a project; an org admin can restore it from Settings.
  const canDelete = (p: ProjectSummary) => p.myRole === 'owner' || me?.user.orgRole === 'org_admin'

  async function remove(p: ProjectSummary): Promise<void> {
    try {
      await archiveProject(p.key)
      toast.success(`Deleted ${p.key} · ${p.name}`, { description: 'An org admin can restore it from Settings → Archived projects.' })
      onChanged?.()
      if (p.key === currentKey) router.push('/')
    } catch (err) {
      toast.error(err instanceof AppError ? err.message : 'Could not delete the project.')
    } finally {
      setDeleting(null)
    }
  }

  async function copyLink(key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/projects/${key}`)
      toast.success(`Link to ${key} copied`)
    } catch {
      toast.error('Could not copy the link')
    }
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Your projects</SidebarGroupLabel>
      <SidebarMenu>
        {projects.map((p) => (
          <SidebarMenuItem key={p.id}>
            <SidebarMenuButton asChild isActive={p.key === currentKey}>
              <Link href={`/projects/${p.key}`}>
                <span className="flex size-4 items-center justify-center rounded-sm bg-sidebar-accent font-mono text-[8px] font-bold text-sidebar-accent-foreground">
                  {p.key.slice(0, 1)}
                </span>
                <span className="truncate">{p.name}</span>
              </Link>
            </SidebarMenuButton>
            {p.storyCounts.ready > 0 ? (
              <SidebarMenuBadge className="group-hover/menu-item:opacity-0" title={`${p.storyCounts.ready} ready to pick up`}>
                {p.storyCounts.ready}
              </SidebarMenuBadge>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuAction showOnHover className="aria-expanded:bg-muted">
                  <MoreHorizontal />
                  <span className="sr-only">More for {p.key}</span>
                </SidebarMenuAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-48" side={isMobile ? 'bottom' : 'right'} align={isMobile ? 'end' : 'start'}>
                <DropdownMenuItem onClick={() => router.push(`/projects/${p.key}`)}>
                  <KanbanSquare /> Open board
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push(`/projects/${p.key}/workflow`)}>
                  <Workflow /> Open workflow
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void copyLink(p.key)}>
                  <Link2 /> Copy link
                </DropdownMenuItem>
                {canDelete(p) ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleting(p)}>
                      <Trash2 /> Delete project
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleting?.key} · {deleting?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The project disappears for everyone. Its stories, memory, code and history are kept, and an org admin can
              restore it from Settings → Archived projects.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && void remove(deleting)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarGroup>
  )
}
