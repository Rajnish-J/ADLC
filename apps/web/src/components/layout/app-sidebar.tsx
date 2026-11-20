'use client'

// sidebar-07, wired to the platform: the project switcher, navigation (workspace + the current project's
// sections), your projects, and you. Collapses to icons (Ctrl+B) and becomes a sheet on mobile.

import { useState, type ComponentProps } from 'react'
import { ChevronsDownUp } from 'lucide-react'
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail } from '@/components/ui/sidebar'
import { useSession } from '@/components/providers/SessionProvider'
import CreateProjectDialog from '@/components/project/CreateProjectDialog'
import { useProjects } from '@/hooks/project/useProjects'
import { useCurrentProject } from './current-project'
import { NavMain } from './nav-main'
import { NavProjects } from './nav-projects'
import { NavUser } from './nav-user'
import { ProjectSwitcher } from './project-switcher'
import { collapseAllSidebarGroups } from './sidebar-collapse'

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  const { me } = useSession()
  const { data: projects, reload: reloadProjects } = useProjects()
  const current = useCurrentProject()
  const [creating, setCreating] = useState(false)

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <ProjectSwitcher
          projects={projects ?? []}
          current={current.data}
          canCreate={Boolean(me?.canCreateProject)}
          onCreate={() => setCreating(true)}
        />
      </SidebarHeader>
      <SidebarContent>
        <NavMain project={current.data} />
        <NavProjects projects={projects ?? []} currentKey={current.key} onChanged={() => void reloadProjects()} />
      </SidebarContent>
      <SidebarFooter>
        {/* Close every expanded group (Settings, the project, its Settings) at once; hidden in the icon-only sidebar. */}
        <button
          type="button"
          onClick={collapseAllSidebarGroups}
          className="mx-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden"
        >
          <ChevronsDownUp className="size-3.5" />
          Collapse all
        </button>
        {me ? <NavUser me={me} /> : null}
      </SidebarFooter>
      <SidebarRail />
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </Sidebar>
  )
}
