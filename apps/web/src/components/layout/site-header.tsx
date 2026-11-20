'use client'

// The inset page header (sidebar-07): sidebar trigger, breadcrumbs for where you are, live status and theme.

import { Fragment } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { LiveIndicator } from '@/components/common/live-indicator'
import { ModeToggle } from '@/components/common/mode-toggle'
import { useCurrentProject } from './current-project'

interface Crumb {
  label: string
  href?: string
}

const SETTINGS_LABELS: Record<string, string> = {
  profile: 'Profile',
  appearance: 'Appearance',
  engine: 'Agent engine',
  vscode: 'VS Code',
  projects: 'Project settings',
  'git-connections': 'Git connections',
  people: 'People',
  system: 'System',
}

const SECTION_LABELS: Record<string, string> = {
  code: 'Code',
  skills: 'Skills',
  workflow: 'Workflow',
  memory: 'Memory',
  agents: 'Agents',
  members: 'Members',
  activity: 'Activity',
  settings: 'Settings',
}

/** Breadcrumbs from the route: Projects › PAY Payments Portal › Board › PAY-2. */
function useCrumbs(): Crumb[] {
  const pathname = usePathname()
  const { key, data: project } = useCurrentProject()
  if (pathname === '/me') return [{ label: 'My stories' }]
  if (pathname === '/work-items') return [{ label: 'My work items' }]
  if (pathname === '/chat') return [{ label: 'Chat' }]
  if (pathname === '/settings' || pathname.startsWith('/settings/')) {
    const section = pathname.split('/')[2]
    return section ? [{ label: 'Settings', href: '/settings' }, { label: SETTINGS_LABELS[section] ?? section }] : [{ label: 'Settings' }]
  }
  if (!key) return [{ label: 'Projects' }]

  const base = `/projects/${key}`
  const crumbs: Crumb[] = [{ label: 'Projects', href: '/' }, { label: project ? `${key} · ${project.name}` : key, href: base }]
  const rest = pathname.slice(base.length).split('/').filter(Boolean)
  if (rest.length === 0) crumbs.push({ label: 'Board' })
  else if (rest[0] === 'workflow' && rest[1] === 'runs' && rest[2]) {
    // A run's page: Workflow › Runs › Run 1a2b3c4d.
    crumbs.push({ label: 'Workflow', href: `${base}/workflow` })
    crumbs.push({ label: 'Runs', href: `${base}/workflow?tab=runs` })
    crumbs.push({ label: `Run ${decodeURIComponent(rest[2]).slice(0, 8)}` })
  } else if (rest[0] === 'workflow' && rest[2] === 'edit') {
    crumbs.push({ label: 'Workflow', href: `${base}/workflow` })
    crumbs.push({ label: 'Edit workflow' })
  } else if (rest[0] === 'stories') {
    crumbs.push({ label: 'Board', href: base })
    crumbs.push({ label: rest[1] === 'new' ? 'New story' : `${key}-${rest[1]}` })
  } else if (rest.length > 1) {
    // A page inside a section, e.g. agents/pr-author → Agents › Pr Author.
    crumbs.push({ label: SECTION_LABELS[rest[0]] ?? rest[0], href: `${base}/${rest[0]}` })
    crumbs.push({ label: decodeURIComponent(rest[1]).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) })
  } else crumbs.push({ label: SECTION_LABELS[rest[0]] ?? rest[0] })
  return crumbs
}

export function SiteHeader() {
  const crumbs = useCrumbs()
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
        <Breadcrumb className="min-w-0">
          <BreadcrumbList>
            {crumbs.map((c, i) => (
              <Fragment key={`${c.label}-${i}`}>
                {i > 0 ? <BreadcrumbSeparator className="hidden md:block" /> : null}
                <BreadcrumbItem className={i < crumbs.length - 1 ? 'hidden md:block' : 'min-w-0'}>
                  {c.href && i < crumbs.length - 1 ? (
                    <BreadcrumbLink asChild>
                      <Link href={c.href}>{c.label}</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage className="truncate">{c.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      <div className="flex items-center gap-2 px-4">
        <LiveIndicator />
        <ModeToggle />
      </div>
    </header>
  )
}
