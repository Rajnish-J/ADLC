'use client'

// Main navigation: the workspace pages, then the current project's sections (a collapsible group, as in
// sidebar-07). Items stay icon-only with tooltips when the sidebar is collapsed.

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Bot, Brain, ChevronRight, ClipboardList, FolderGit2, FolderKanban, History, KanbanSquare, ListTodo, MessageSquare, Settings, Sparkles, Users, Workflow, Zap } from 'lucide-react'
import type { Permission, ProjectDetail } from '@sdlc/contracts'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { useSession } from '@/components/providers/SessionProvider'
import { DEFAULT_SETTINGS_SECTION, settingsHref, visibleSettingsSections } from '@/components/settings/settingsSections'
import { useCollapseAll } from './sidebar-collapse'
import { projectSettingsHref, visibleProjectSettingsSections } from '@/components/project-settings/projectSettingsSections'
import { announceQuickRun, quickRunHref, useComposerShortcut } from '@/components/work/RunComposerProvider'

interface NavItem {
  title: string
  href: string
  icon: ReactNode
  /** Highlight only on an exact path match (otherwise also on sub-paths). */
  exact?: boolean
  requires?: Permission
}

const WORKSPACE: NavItem[] = [
  { title: 'Projects', href: '/', icon: <FolderKanban />, exact: true },
  { title: 'My stories', href: '/me', icon: <ListTodo /> },
  { title: 'My work items', href: '/work-items', icon: <ClipboardList /> },
  { title: 'Chat', href: '/chat', icon: <MessageSquare /> },
]


function projectSections(key: string): NavItem[] {
  const base = `/projects/${key}`
  return [
    { title: 'Activity', href: `${base}/activity`, icon: <History />, requires: 'audit.view' },
    { title: 'Board', href: base, icon: <KanbanSquare />, exact: true },
    { title: 'Code', href: `${base}/code`, icon: <FolderGit2 /> },
    { title: 'Workflow', href: `${base}/workflow`, icon: <Workflow /> },
    { title: 'Memory', href: `${base}/memory`, icon: <Brain /> },
    { title: 'Agents', href: `${base}/agents`, icon: <Bot /> },
    { title: 'Skills', href: `${base}/skills`, icon: <Sparkles /> },
    { title: 'Members', href: `${base}/members`, icon: <Users /> },
  ]
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href || (item.title === 'Board' && pathname.startsWith(`${item.href}/stories`))
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}

function Items({ items, pathname, children }: { items: NavItem[]; pathname: string; children?: ReactNode }) {
  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton asChild isActive={isActive(pathname, item)} tooltip={item.title}>
            <Link href={item.href}>
              {item.icon}
              <span>{item.title}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
      {children}
    </SidebarMenu>
  )
}

/**
 * Settings as a collapsible group: its sections (Profile, Appearance, … and, for org admins, the organization)
 * open as sub-items here instead of a second nav column on the page. It opens by itself on any Settings page;
 * in the icon-only sidebar the icon just opens Settings.
 */
function SettingsNav({ pathname }: { pathname: string }) {
  const { me } = useSession()
  const { state, isMobile } = useSidebar()
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/')
  const [open, setOpen] = useState(inSettings)
  useEffect(() => {
    if (inSettings) setOpen(true)
  }, [inSettings])
  useCollapseAll(() => setOpen(false))
  const sections = visibleSettingsSections(me?.user.orgRole === 'org_admin')
  const active = inSettings ? (pathname.split('/')[2] ?? DEFAULT_SETTINGS_SECTION) : null
  const showGroups = new Set(sections.map((s) => s.group)).size > 1

  if (state === 'collapsed' && !isMobile) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={inSettings} tooltip="Settings">
          <Link href={settingsHref(DEFAULT_SETTINGS_SECTION)}>
            <Settings />
            <span>Settings</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen} className="group/settings">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton isActive={inSettings && !open} tooltip="Settings">
            <Settings />
            <span>Settings</span>
            <ChevronRight className="ml-auto transition-transform group-data-[state=open]/settings:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {sections.map((s, i) => (
              <SidebarMenuSubItem key={s.id}>
                {showGroups && s.group !== sections[i - 1]?.group ? (
                  <p className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-sidebar-foreground/50 uppercase">{s.group}</p>
                ) : null}
                <SidebarMenuSubButton asChild isActive={active === s.id}>
                  <Link href={settingsHref(s.id)}>
                    {s.icon}
                    <span>{s.title}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

/**
 * The project's Settings as a collapsible group, like the workspace Settings: its sections (General, Agents & skills,
 * Harnesses, Memory, …) are sub-items here, not a second nav column on the page. It opens by itself on the project's
 * Settings pages; in the icon-only sidebar the icon just opens them.
 */
function ProjectSettingsNav({ project, pathname }: { project: ProjectDetail; pathname: string }) {
  const { state, isMobile } = useSidebar()
  const base = `/projects/${project.key}/settings`
  const inSettings = pathname === base || pathname.startsWith(`${base}/`)
  const [open, setOpen] = useState(inSettings)
  useEffect(() => {
    if (inSettings) setOpen(true)
  }, [inSettings])
  useCollapseAll(() => setOpen(false))
  const sections = visibleProjectSettingsSections(project.permissions)
  const active = inSettings ? (pathname.slice(base.length).split('/')[1] || sections[0]?.id) : null

  if (state === 'collapsed' && !isMobile) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={inSettings} tooltip="Settings">
          <Link href={projectSettingsHref(project.key)}>
            <Settings />
            <span>Settings</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen} className="group/project-settings">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton isActive={inSettings && !open} tooltip="Settings">
            <Settings />
            <span>Settings</span>
            <ChevronRight className="ml-auto transition-transform group-data-[state=open]/project-settings:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {sections.map((s) => (
              <SidebarMenuSubItem key={s.id}>
                <SidebarMenuSubButton asChild isActive={active === s.id}>
                  <Link href={projectSettingsHref(project.key, s.id)}>
                    {s.icon}
                    <span>{s.title}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

/**
 * Quick run: the project's Workflow page, Runs tab, with the composer focused (also Ctrl/⌘+K). Runs are started and
 * followed there, next to every run and its evaluations — not in a small dialog.
 */
function QuickRun({ projectKey }: { projectKey: string }) {
  const shortcut = useComposerShortcut()
  return (
    <SidebarMenu className="mb-1">
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip={`Quick run (${shortcut})`}>
          <Link href={quickRunHref(projectKey)} onClick={() => announceQuickRun()}>
            <Zap />
            <span>Quick run</span>
          </Link>
        </SidebarMenuButton>
        <SidebarMenuBadge className="font-mono text-[10px] text-muted-foreground">{shortcut}</SidebarMenuBadge>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export function NavMain({ project }: { project: ProjectDetail | null }) {
  const pathname = usePathname()
  const [projectOpen, setProjectOpen] = useState(true)
  useCollapseAll(() => setProjectOpen(false))
  const sections = project ? projectSections(project.key).filter((s) => !s.requires || project.permissions.includes(s.requires)) : []
  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Workspace</SidebarGroupLabel>
        <Items items={WORKSPACE} pathname={pathname}>
          <SettingsNav pathname={pathname} />
        </Items>
      </SidebarGroup>
      {project ? (
        <Collapsible open={projectOpen} onOpenChange={setProjectOpen} className="group/collapsible">
          <SidebarGroup>
            <SidebarGroupLabel asChild>
              <CollapsibleTrigger>
                <span className="truncate">
                  {project.key} · {project.name}
                </span>
                <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
              </CollapsibleTrigger>
            </SidebarGroupLabel>
            <CollapsibleContent>
              {/* The same guide line as the Settings sub-items; dropped in the icon-only sidebar so icons stay aligned. */}
              <SidebarGroupContent className="ml-3.5 w-auto border-l border-sidebar-border pl-2 group-data-[collapsible=icon]:ml-0 group-data-[collapsible=icon]:border-l-0 group-data-[collapsible=icon]:pl-0">
                <QuickRun projectKey={project.key} />
                <Items items={sections} pathname={pathname}>
                  <ProjectSettingsNav project={project} pathname={pathname} />
                </Items>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
      ) : null}
    </>
  )
}
