'use client'

// The one Settings page: your account (profile, appearance, agent engine, VS Code), every project you belong to,
// and — for org admins — the organization (Git connections, people, system). Each section has its own URL
// (/settings/<section>), so links from elsewhere (the Code page, the user menu) open the right one. The sections
// are listed in the main sidebar's collapsible "Settings" group — the page itself has no second nav column.

import { Suspense, useEffect, type ReactNode } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Settings } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'
import ArchivedProjectsCard from './project/ArchivedProjectsCard'
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, visibleSettingsSections } from './settingsSections'

export { settingsHref } from './settingsSections'

const RENDER: Record<string, () => ReactNode> = {
  profile: () => <ST.ProfileSection />,
  appearance: () => <ST.AppearanceSection />,
  engine: () => <ST.EngineSection />,
  vscode: () => <ST.VsCodeSection />,
  'git-connections': () => <ST.GitConnectionsSection />,
  people: () => <ST.PeopleSection />,
  system: () => <ST.SystemSection />,
  'archived-projects': () => <ArchivedProjectsCard />,
}

/** Old links (/settings/projects?project=KEY): a project's settings now live on the project. */
function ProjectSettingsRedirect() {
  const router = useRouter()
  const wanted = useSearchParams().get('project')
  const { data: projects } = ST.useProjects()
  useEffect(() => {
    const key = wanted ?? projects?.[0]?.key
    if (key) router.replace(`/projects/${encodeURIComponent(key)}/settings`)
    else if (projects) router.replace('/')
  }, [wanted, projects, router])
  return <UI.Skeleton className="h-64 rounded-xl" />
}

export default function SettingsContainer() {
  const params = useParams<{ section?: string }>()
  const { me, loading } = ST.useSession()
  const sections = visibleSettingsSections(me?.user.orgRole === 'org_admin')
  const requested = params.section ?? DEFAULT_SETTINGS_SECTION
  const section = sections.find((s) => s.id === requested)
  if (requested === 'projects') {
    return (
      <Suspense fallback={<UI.Skeleton className="h-64 rounded-xl" />}>
        <ProjectSettingsRedirect />
      </Suspense>
    )
  }

  return (
    // One centred column: the sections moved into the sidebar, so the page no longer needs its left nav space.
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <UI.PageHeader
        leading={
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <Settings className="size-5" />
          </span>
        }
        title={section ? `Settings · ${section.title}` : 'Settings'}
        description={section ? `${section.group} settings.` : 'Your account and — for org admins — the organization. Each project has its own Settings page.'}
      />
      <div className="flex min-w-0 flex-col gap-6">
        {loading ? (
          <UI.Skeleton className="h-64 rounded-xl" />
        ) : section ? (
          <Suspense fallback={<UI.Skeleton className="h-64 rounded-xl" />}>{RENDER[section.id]?.()}</Suspense>
        ) : (
          <UI.EmptyState
            icon={<Settings />}
            title={SETTINGS_SECTIONS.some((s) => s.id === requested) ? 'Only org admins can open this section' : 'No such settings section'}
            description="Pick a section under Settings in the sidebar."
          />
        )}
      </div>
    </div>
  )
}
