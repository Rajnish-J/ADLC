'use client'

// sidebar-07's team switcher, as a project switcher: the current project (or the platform when outside one),
// your projects with Alt+1…9 shortcuts, and "New project" for org admins.

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronsUpDown, FolderKanban, Plus, Workflow } from 'lucide-react'
import { PROJECT_ROLE_LABELS, type ProjectDetail, type ProjectSummary } from '@sdlc/contracts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'

interface ProjectSwitcherProps {
  projects: ProjectSummary[]
  current: ProjectDetail | null
  canCreate: boolean
  onCreate: () => void
}

export function ProjectSwitcher({ projects, current, canCreate, onCreate }: ProjectSwitcherProps) {
  const { isMobile } = useSidebar()
  const router = useRouter()

  // Alt+1…9 jumps to a project (skipped while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      const index = Number(e.key) - 1
      const project = Number.isInteger(index) && index >= 0 ? projects[index] : undefined
      if (!project) return
      e.preventDefault()
      router.push(`/projects/${project.key}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projects, router])

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary font-mono text-[10px] font-bold text-sidebar-primary-foreground">
                {current ? current.key.slice(0, 3) : <Workflow className="size-4" />}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{current ? current.name : 'SDLC Platform'}</span>
                <span className="truncate text-xs text-sidebar-foreground/70">
                  {current ? (current.myRole ? PROJECT_ROLE_LABELS[current.myRole] : 'Admin access') : 'Synergech'}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-60"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">Projects</DropdownMenuLabel>
            {projects.map((p, index) => (
              <DropdownMenuItem key={p.id} onClick={() => router.push(`/projects/${p.key}`)} className="gap-2 p-2">
                <div className="flex size-6 items-center justify-center rounded-md border font-mono text-[9px] font-bold">
                  {p.key.slice(0, 3)}
                </div>
                <span className="truncate">{p.name}</span>
                {index < 9 ? <DropdownMenuShortcut>Alt+{index + 1}</DropdownMenuShortcut> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push('/')} className="gap-2 p-2">
              <div className="flex size-6 items-center justify-center rounded-md border">
                <FolderKanban className="size-3.5" />
              </div>
              All projects
            </DropdownMenuItem>
            {canCreate ? (
              <DropdownMenuItem onClick={onCreate} className="gap-2 p-2">
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <Plus className="size-4" />
                </div>
                <div className="font-medium text-muted-foreground">New project</div>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
