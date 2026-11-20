'use client'

// Project memory: what the project has learned — conventions, decisions, learnings and delivered-story summaries —
// shared with every developer and given to every agent. Leads curate it: they review proposals (promoted story
// notes and story roll-ups), pin what every agent must see, and archive what no longer holds. Every tab is a table:
// a row opens the item's details, its ⋯ menu has the item's options.

import { useEffect, useState } from 'react'
import { Inbox, Pin, Plus, Search } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as M from '@/imports/memory.imports'
import * as P from '@/imports/project.imports'

type KindFilter = M.MemoryKind | 'all'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function Memory({ project }: { project: P.ProjectDetail }) {
  const canCurate = project.permissions.includes('memory.curate')
  const [query, setQuery] = useState('')
  const q = useDebounced(query.trim(), 300)
  const [kind, setKind] = useState<KindFilter>('all')
  const all = M.useProjectMemory(project.key)
  const searched = M.useProjectMemory(project.key, { q: q || undefined, status: 'accepted' })
  const storyItems = M.useProjectMemory(project.key, { scope: 'story' })
  const profile = M.useProjectProfile(project.key)
  const [tab, setTab] = useState('project')
  const profileProposal = profile.data?.pending?.status === 'proposed' ? profile.data.pending : null

  const reload = () => {
    void all.reload()
    void searched.reload()
    void storyItems.reload()
  }
  const actions = M.useMemoryActions(project.key, reload)
  // The item whose details are open — looked up in fresh data, so the sheet follows live changes.
  const [openId, setOpenId] = useState<string | null>(null)
  const view = (m: M.MemoryItem) => setOpenId(m.id)

  const items = all.data ?? []
  const accepted = (q ? (searched.data ?? []) : items.filter((m) => m.status === 'accepted')).filter((m) => kind === 'all' || m.kind === kind)
  const proposals = items.filter((m) => m.status === 'proposed')
  const archived = items.filter((m) => m.status === 'archived' || m.status === 'rejected')
  const stories = (storyItems.data ?? []).filter((m) => m.status !== 'archived')
  const opened = openId ? ([...items, ...(searched.data ?? []), ...(storyItems.data ?? [])].find((m) => m.id === openId) ?? null) : null
  const weekAgo = Date.now() - 7 * 24 * 3600_000
  const acceptedCount = items.filter((m) => m.status === 'accepted').length
  const waiting = proposals.length + (profileProposal ? 1 : 0)

  const stats: UI.StatItem[] = [
    { label: 'Project memory', value: acceptedCount, footer: { title: 'Given to every agent in the project' } },
    {
      label: 'Waiting for review',
      value: waiting,
      badge: waiting ? { label: canCurate ? 'Review' : 'Pending', icon: <Inbox />, variant: 'warning' } : undefined,
      footer: { title: canCurate ? 'Promoted notes, story roll-ups and profile updates' : 'A lead accepts or rejects these' },
    },
    { label: 'Pinned', value: items.filter((m) => m.pinned && m.status === 'accepted').length, badge: { label: 'Always included', icon: <Pin /> }, footer: { title: 'Every agent prompt includes these' } },
    { label: 'Story notes this week', value: stories.filter((m) => Date.parse(m.createdAt) > weekAgo).length, footer: { title: `${stories.length} across all stories` } },
  ]

  if (all.error) return <UI.ErrorAlert message={all.error.message} />

  return (
    <>
      {/* The profile is a row in the table ("Project profile vN"); only its pending state is shown up here. */}
      {profile.data ? <M.ProfileStatusBanner state={profile.data} onReview={() => setTab('proposals')} /> : null}

      {all.loading && !all.data ? <UI.Skeleton className="h-36 rounded-xl" /> : <UI.StatCards items={stats} />}

      <UI.Tabs value={tab} onValueChange={setTab} className="gap-4">
        <UI.TabsList>
          <UI.TabsTrigger value="project">Project memory</UI.TabsTrigger>
          <UI.TabsTrigger value="proposals">
            Proposals {waiting ? <UI.Badge variant="warning" className="ml-1 px-1.5">{waiting}</UI.Badge> : null}
          </UI.TabsTrigger>
          <UI.TabsTrigger value="stories">From stories</UI.TabsTrigger>
          <UI.TabsTrigger value="archived">Archived</UI.TabsTrigger>
        </UI.TabsList>

        <UI.TabsContent value="project">
          <M.MemoryTable
            items={accepted}
            projectKey={project.key}
            variant="project"
            actions={actions}
            onView={view}
            keepOrder
            emptyMessage={q || kind !== 'all' ? 'Nothing matches — try another search or kind.' : 'No project memory yet. Promote useful story notes, or add conventions and decisions the whole project should follow.'}
            toolbar={
              <div className="flex flex-1 flex-col gap-3 @3xl/main:flex-row @3xl/main:items-center">
                <UI.InputGroup className="@3xl/main:max-w-sm">
                  <UI.InputGroupAddon>
                    <Search />
                  </UI.InputGroupAddon>
                  <UI.InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search project memory" aria-label="Search project memory" />
                </UI.InputGroup>
                <UI.ToggleGroup type="single" variant="outline" size="sm" value={kind} onValueChange={(v) => setKind((v || 'all') as KindFilter)} className="flex-wrap">
                  <UI.ToggleGroupItem value="all" className="px-3">
                    All
                  </UI.ToggleGroupItem>
                  {(['convention', 'decision', 'learning', 'summary', 'note'] as const).map((k) => (
                    <UI.ToggleGroupItem key={k} value={k} className="px-3">
                      {M.KIND_META[k].label}
                    </UI.ToggleGroupItem>
                  ))}
                </UI.ToggleGroup>
              </div>
            }
          />
        </UI.TabsContent>

        <UI.TabsContent value="proposals" className="flex flex-col gap-4">
          {profileProposal ? <M.ProfileProposalCard projectKey={project.key} proposal={profileProposal} current={profile.data?.current ?? null} /> : null}
          <M.MemoryTable
            items={proposals}
            projectKey={project.key}
            variant="proposals"
            actions={actions}
            onView={view}
            emptyMessage="Nothing to review. Story notes promoted by developers, the roll-ups of finished stories and agent-run summaries wait here for a lead."
          />
        </UI.TabsContent>

        <UI.TabsContent value="stories">
          {storyItems.error ? (
            <UI.ErrorAlert message={storyItems.error.message} />
          ) : (
            <M.MemoryTable items={stories} projectKey={project.key} variant="stories" actions={actions} onView={view} emptyMessage="No story memory yet." />
          )}
        </UI.TabsContent>

        <UI.TabsContent value="archived">
          <M.MemoryTable
            items={archived}
            projectKey={project.key}
            variant="archived"
            actions={actions}
            onView={view}
            emptyMessage="Nothing archived. Archived and rejected items, and earlier project profile versions, stay here for reference."
          />
        </UI.TabsContent>
      </UI.Tabs>

      <M.MemoryDetailSheet item={opened} projectKey={project.key} actions={actions} onOpenChange={(open) => !open && setOpenId(null)} />
      {actions.dialogs}
    </>
  )
}

export default function MemoryContainer() {
  return (
    <P.ProjectShell
      title="Memory"
      description="What this project has learned — shared with every developer and given to every agent."
      actions={(project) =>
        project.permissions.includes('memory.curate') ? (
          <>
            <M.GenerateProfileButton projectKey={project.key} />
            <M.AddMemoryDialog
              projectKey={project.key}
              trigger={
                <UI.Button>
                  <Plus /> Add memory
                </UI.Button>
              }
            />
          </>
        ) : null
      }
    >
      {(project) => <Memory project={project} />}
    </P.ProjectShell>
  )
}
