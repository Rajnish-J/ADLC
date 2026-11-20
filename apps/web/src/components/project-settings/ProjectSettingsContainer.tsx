'use client'

// A project's Settings (/projects/KEY/settings/<section>): its details, which agent and skills run each step of
// every workflow, the harnesses its runs may use, what the platform remembers, the linked repository and Azure
// Boards, and archiving. The sections are listed under the project's "Settings" in the main sidebar (a dropdown on
// phones) — the page itself has no second nav column. Every member can read it; each card edits with its own role.

import type { ReactNode } from 'react'
import { useParams, useRouter } from 'next/navigation'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'
import * as C from '@/imports/catalog.imports'
import HarnessPolicy from '@/components/catalog/HarnessPolicy'
import AzureBoardsCard from '@/components/settings/project/AzureBoardsCard'
import DangerZoneCard from '@/components/settings/project/DangerZoneCard'
import GeneralCard from '@/components/settings/project/GeneralCard'
import RepositoryCard from '@/components/settings/project/RepositoryCard'
import AgentMappingSection from './AgentMappingSection'
import MemorySettingsSection from './MemorySettingsSection'
import { DEFAULT_PROJECT_SETTINGS_SECTION, projectSettingsHref, visibleProjectSettingsSections } from './projectSettingsSections'

export { projectSettingsHref }

const RENDER: Record<string, (project: ST.ProjectDetail, setProject: (p: ST.ProjectDetail) => void) => ReactNode> = {
  general: (p, set) => <GeneralCard project={p} onSaved={set} />,
  agents: (p) => <AgentMappingSection project={p} />,
  harnesses: (p) => <HarnessPolicy project={p} />,
  memory: (p, set) => <MemorySettingsSection project={p} onSaved={set} />,
  repository: (p) => <RepositoryCard project={p} />,
  boards: (p) => <AzureBoardsCard project={p} />,
  danger: (p) => <DangerZoneCard project={p} />,
}

function Settings({ projectKey, section }: { projectKey: string; section: string }) {
  const router = useRouter()
  const { data: project, error, loading, setData } = ST.useProject(projectKey)
  if (error) return <UI.ErrorAlert message={error.message} />
  if (loading || !project) return <UI.Skeleton className="h-96 rounded-xl" />

  const sections = visibleProjectSettingsSections(project.permissions)
  const active = sections.find((s) => s.id === section) ?? sections[0]

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="md:hidden">
        <UI.Select value={active.id} onValueChange={(v) => router.push(projectSettingsHref(project.key, v))}>
          <UI.SelectTrigger className="w-full" aria-label="Settings section">
            <UI.SelectValue />
          </UI.SelectTrigger>
          <UI.SelectContent>
            {sections.map((s) => (
              <UI.SelectItem key={s.id} value={s.id}>
                {s.title}
              </UI.SelectItem>
            ))}
          </UI.SelectContent>
        </UI.Select>
      </div>
      {RENDER[active.id]?.(project, setData)}
    </div>
  )
}

const DESCRIPTIONS: Record<string, string> = {
  general: 'The project’s name and description.',
  agents: 'Which agent, skills and harness run each agent step, across every workflow of this project.',
  harnesses: 'Which coding harnesses this project’s runs may use, and the default one.',
  memory: 'What the platform remembers on its own, and what runs are given.',
  repository: 'The repository the project’s code lives in.',
  boards: 'Syncing the project’s stories with Azure Boards.',
  danger: 'Archiving the project.',
}

export default function ProjectSettingsContainer() {
  const params = useParams<{ key: string; section?: string[] }>()
  const section = params.section?.[0] ?? DEFAULT_PROJECT_SETTINGS_SECTION
  const title = visibleProjectSettingsSections(['project.update']).find((s) => s.id === section)?.title
  return (
    // One centred column for the header and the section, like the workspace Settings page.
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <C.ProjectShell title={title ? `Settings · ${title}` : 'Settings'} description={DESCRIPTIONS[section] ?? 'This project’s settings.'}>
        {(project) => <Settings projectKey={project.key} section={section} />}
      </C.ProjectShell>
    </div>
  )
}
