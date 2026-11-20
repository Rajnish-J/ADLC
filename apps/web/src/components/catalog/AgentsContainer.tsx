'use client'

import { Fragment, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bot, Plus, Search } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as C from '@/imports/catalog.imports'

/** Where an agent comes from: shipped with the platform, found in the project's codebase, or created in Chat. Skills have their own page. */
const SOURCES: Array<{ id: string; label: string; match: (a: C.Agent) => boolean; empty: string }> = [
  { id: 'all', label: 'All', match: () => true, empty: 'No agents yet.' },
  { id: 'builtin', label: 'Built-in', match: (a) => a.source === 'builtin', empty: 'No built-in agents.' },
  {
    id: 'repo',
    label: 'From codebase',
    match: (a) => a.source === 'repo',
    empty:
      'Agents defined in the project’s repository (.claude/agents, .github/agents, AGENTS.md, agent.yaml, Copilot and Cursor rules) appear here once the repository is linked on the Code page and synced.',
  },
  {
    id: 'platform',
    label: 'Platform',
    match: (a) => a.source === 'platform',
    empty: 'Agents you create here (New agent) or with the Agents assistant in Chat appear here.',
  },
]

function Agents({ project }: { project: C.ProjectDetail }) {
  const { data: all, error, loading, setData } = C.useAgents(project.key)
  const agents = all ? all.filter((a) => a.kind === 'agent') : null
  const { data: mappings } = C.useStepMappings(project.key)
  const [busy, setBusy] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const canConfigure = project.permissions.includes('agent.configure')

  async function toggle(agent: C.Agent, enabled: boolean): Promise<void> {
    if (!agents) return
    setBusy(agent.slug)
    try {
      await C.setAgentEnabled(project.key, agent.slug, enabled)
      setData((all ?? []).map((a) => (a.slug === agent.slug ? { ...a, enabled } : a)))
      UI.toast.success(`${agent.name} ${enabled ? 'enabled' : 'disabled'} for ${project.key}`)
    } catch (err) {
      UI.toast.error(err instanceof C.AppError ? err.message : 'Could not change the agent.')
    } finally {
      setBusy(null)
    }
  }

  if (error) return <UI.ErrorAlert message={error.message} />
  if (loading || !agents) return <UI.Skeleton className="h-96 rounded-xl" />
  if (agents.length === 0) {
    return (
      <UI.EmptyState
        icon={<Bot />}
        title="No agents available"
        description="The platform’s built-in agents haven’t been installed. Run the database seed (npm run db:seed) to add them."
      />
    )
  }

  const q = search.trim().toLowerCase()
  const matching = q ? agents.filter((a) => `${a.name} ${a.description} ${a.tools.join(' ')}`.toLowerCase().includes(q)) : agents
  const enabled = agents.filter((a) => a.enabled).length
  const restricted = agents.filter((a) => a.requiredRole !== null).length
  const locked = agents.filter((a) => !a.usable).length

  const stats: UI.StatItem[] = [
    { label: 'Agents enabled', value: `${enabled} / ${agents.length}`, footer: { title: canConfigure ? 'Switch agents on or off for this project' : 'Leads and owners can change this' } },
    { label: 'Run in VS Code', value: agents.filter((a) => a.executionTarget === 'local').length, footer: { title: 'Against the developer’s checkout' } },
    { label: 'From codebase', value: agents.filter((a) => a.source === 'repo').length, footer: { title: 'Agents defined in the repository' } },
    {
      label: 'Role-restricted',
      value: restricted,
      badge: locked ? { label: `${locked} locked for you`, variant: 'warning' } : undefined,
      footer: { title: 'Usable only from a minimum project role' },
    },
  ]

  return (
    <>
      <UI.StatCards items={stats} />
      <UI.Tabs defaultValue="all" className="gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <UI.TabsList className="flex-wrap">
            {SOURCES.map((s) => {
              const n = matching.filter(s.match).length
              return (
                <UI.TabsTrigger key={s.id} value={s.id}>
                  {s.label}
                  <UI.Badge variant="secondary" className="ml-1 h-4 px-1.5 tabular-nums">
                    {n}
                  </UI.Badge>
                </UI.TabsTrigger>
              )
            })}
          </UI.TabsList>
          <UI.InputGroup className="w-full sm:ml-auto sm:w-64">
            <UI.InputGroupAddon>
              <Search />
            </UI.InputGroupAddon>
            <UI.InputGroupInput placeholder="Search agents or tools…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </UI.InputGroup>
        </div>
        {SOURCES.map((source) => {
          const list = matching.filter(source.match)
          return (
            <UI.TabsContent key={source.id} value={source.id}>
              {list.length === 0 ? (
                <UI.EmptyState icon={<Bot />} title="Nothing here yet" description={q ? 'Nothing matches your search.' : source.empty} />
              ) : (
                <UI.Card className="py-0">
                  <UI.ItemGroup>
                    {list.map((a, i) => (
                      <Fragment key={a.id}>
                        {i > 0 ? <UI.ItemSeparator /> : null}
                        <C.AgentRow agent={a} projectKey={project.key} canConfigure={canConfigure} busy={busy === a.slug} onToggle={(on) => void toggle(a, on)} usedIn={mappings?.get(a.slug)} />
                      </Fragment>
                    ))}
                  </UI.ItemGroup>
                </UI.Card>
              )}
            </UI.TabsContent>
          )
        })}
      </UI.Tabs>
    </>
  )
}

/** "New agent": write a platform agent by hand (the Chat assistant is the other way), then open its page. */
function NewAgentButton({ projectKey }: { projectKey: string }) {
  const router = useRouter()
  const [mode, setMode] = useState<C.AgentFormMode | null>(null)
  return (
    <>
      <UI.Button variant="outline" onClick={() => setMode({ type: 'create' })}>
        <Plus /> New agent
      </UI.Button>
      <C.AgentFormSheet projectKey={projectKey} mode={mode} onClose={() => setMode(null)} onSaved={(agent) => router.push(C.agentHref(projectKey, agent.slug))} />
    </>
  )
}

export default function AgentsContainer() {
  return (
    <C.ProjectShell
      title="Agents"
      description="The agents this project's workflow can use, where each runs, and the tools it may call."
      actions={(project) =>
        project.permissions.includes('agent.configure') ? (
          <>
            <C.CreateWithAiButton agent="agents" projectKey={project.key} />
            <NewAgentButton projectKey={project.key} />
          </>
        ) : null
      }
    >
      {(project) => <Agents project={project} />}
    </C.ProjectShell>
  )
}
