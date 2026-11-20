'use client'

// Skills: reusable capabilities an agent can load (.claude/skills/<name>/SKILL.md), imported from the project's
// repository on its default branch. Same row, search and enable switch as the Agents page.

import { Fragment, useState } from 'react'
import Link from 'next/link'
import { Search, Sparkles } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as C from '@/imports/catalog.imports'

function Skills({ project }: { project: C.ProjectDetail }) {
  const { data: all, error, loading, setData } = C.useAgents(project.key)
  const { data: mappings } = C.useStepMappings(project.key)
  const [busy, setBusy] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const canConfigure = project.permissions.includes('agent.configure')

  async function toggle(skill: C.Agent, enabled: boolean): Promise<void> {
    if (!all) return
    setBusy(skill.slug)
    try {
      await C.setAgentEnabled(project.key, skill.slug, enabled)
      setData(all.map((a) => (a.slug === skill.slug ? { ...a, enabled } : a)))
      UI.toast.success(`${skill.name} ${enabled ? 'enabled' : 'disabled'} for ${project.key}`)
    } catch (err) {
      UI.toast.error(err instanceof C.AppError ? err.message : 'Could not change the skill.')
    } finally {
      setBusy(null)
    }
  }

  if (error) return <UI.ErrorAlert message={error.message} />
  if (loading || !all) return <UI.Skeleton className="h-96 rounded-xl" />

  const skills = all.filter((a) => a.kind === 'skill')
  const codeHref = `/projects/${encodeURIComponent(project.key)}/code`
  if (skills.length === 0) {
    return (
      <UI.EmptyState
        icon={<Sparkles />}
        title="No skills yet"
        description={
          project.repository
            ? `None of ${project.repository.displayName}’s default branch defines a skill (.claude/skills/<name>/SKILL.md). Add one and Sync.`
            : 'Skills come from the project’s repository (.claude/skills/<name>/SKILL.md). Link it on the Code page and they appear here.'
        }
      >
        <UI.Button variant="outline" size="sm" asChild>
          <Link href={codeHref}>Open the Code page</Link>
        </UI.Button>
      </UI.EmptyState>
    )
  }

  const q = search.trim().toLowerCase()
  const shown = q ? skills.filter((s) => `${s.name} ${s.description} ${s.tools.join(' ')}`.toLowerCase().includes(q)) : skills
  const stats: UI.StatItem[] = [
    { label: 'Skills', value: skills.length, footer: { title: 'Defined in the repository' } },
    { label: 'Enabled', value: `${skills.filter((s) => s.enabled).length} / ${skills.length}`, footer: { title: canConfigure ? 'Switch skills on or off for this project' : 'Leads and owners can change this' } },
    {
      label: 'Need attention',
      value: skills.filter((s) => s.issues.length > 0).length,
      footer: { title: 'Missing fields, or bundled scripts to review' },
    },
    { label: 'Branch', value: skills[0]?.branch ?? '—', footer: { title: 'Skills follow the default branch' } },
  ]

  return (
    <>
      <UI.StatCards items={stats} />
      <div className="flex flex-wrap items-center gap-3">
        <UI.InputGroup className="w-full sm:w-72">
          <UI.InputGroupAddon>
            <Search />
          </UI.InputGroupAddon>
          <UI.InputGroupInput placeholder="Search skills or tools…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </UI.InputGroup>
      </div>
      {shown.length === 0 ? (
        <UI.EmptyState icon={<Sparkles />} title="Nothing matches your search" />
      ) : (
        <UI.Card className="py-0">
          <UI.ItemGroup>
            {shown.map((s, i) => (
              <Fragment key={s.id}>
                {i > 0 ? <UI.ItemSeparator /> : null}
                <C.AgentRow agent={s} projectKey={project.key} canConfigure={canConfigure} busy={busy === s.slug} onToggle={(on) => void toggle(s, on)} usedIn={mappings?.get(s.slug)} />
              </Fragment>
            ))}
          </UI.ItemGroup>
        </UI.Card>
      )}
    </>
  )
}

export default function SkillsContainer() {
  return (
    <C.ProjectShell
      title="Skills"
      description="Reusable capabilities your agents can load — imported from the project’s repository or created in Chat."
      actions={(project) => (project.permissions.includes('agent.configure') ? <C.CreateWithAiButton agent="skills" projectKey={project.key} /> : null)}
    >
      {(project) => <Skills project={project} />}
    </C.ProjectShell>
  )
}
