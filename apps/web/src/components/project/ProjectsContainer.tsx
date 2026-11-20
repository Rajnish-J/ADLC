'use client'

import { useState } from 'react'
import { CircleCheck, FolderKanban, Hand, Plus, Timer } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as P from '@/imports/project.imports'

function sum(projects: P.ProjectSummary[], status: P.StoryStatus): number {
  return projects.reduce((n, p) => n + p.storyCounts[status], 0)
}

export default function ProjectsContainer() {
  const { me } = P.useSession()
  const { data: projects, error, loading } = P.useProjects()
  const [creating, setCreating] = useState(false)
  const isAdmin = me?.user.orgRole === 'org_admin'
  const list = projects ?? []

  const stats: UI.StatItem[] = [
    {
      label: 'Projects',
      value: list.length,
      footer: { title: isAdmin ? 'Every project in the organization' : 'Projects you are a member of' },
    },
    {
      label: 'Ready to pick up',
      value: sum(list, 'ready'),
      badge: { label: 'Ready', icon: <Hand />, variant: 'outline' },
      footer: { title: 'Waiting for a developer', description: 'Pick them up here or in VS Code' },
    },
    {
      label: 'In progress',
      value: sum(list, 'in_progress'),
      badge: { label: 'Active', icon: <Timer />, variant: 'warning' },
      footer: { title: 'Being worked on with agents' },
    },
    {
      label: 'In review',
      value: sum(list, 'in_review'),
      badge: { label: `${sum(list, 'done')} done`, icon: <CircleCheck />, variant: 'success' },
      footer: { title: 'Waiting for a lead to sign off' },
    },
  ]

  return (
    <>
      <UI.PageHeader
        title="Projects"
        description="Every project you can see, how its stories are moving, and where help is needed."
        actions={
          me?.canCreateProject ? (
            <UI.Button onClick={() => setCreating(true)}>
              <Plus /> New project
            </UI.Button>
          ) : null
        }
      />

      {error ? <UI.ErrorAlert message={error.message} /> : null}

      {loading && !projects ? (
        <div className="grid gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <UI.Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : (
        <UI.StatCards items={stats} />
      )}

      {projects && projects.length === 0 ? (
        <UI.EmptyState
          icon={<FolderKanban />}
          title="No projects yet"
          description={me?.canCreateProject ? 'Create the first one.' : 'Ask an admin or a project owner to add you to a project.'}
        >
          {me?.canCreateProject ? (
            <UI.Button onClick={() => setCreating(true)}>
              <Plus /> New project
            </UI.Button>
          ) : null}
        </UI.EmptyState>
      ) : null}

      {list.length > 0 ? (
        <div className="grid gap-4 @2xl/main:grid-cols-2 @6xl/main:grid-cols-3">
          {list.map((p) => (
            <P.ProjectCard key={p.id} project={p} />
          ))}
        </div>
      ) : null}

      <P.CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}
