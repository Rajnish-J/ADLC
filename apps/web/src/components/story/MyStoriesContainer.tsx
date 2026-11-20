'use client'

// Everything assigned to you, across every project — the developer's home.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CircleAlert, ListTodo, Timer } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as S from '@/imports/story.imports'

const ALL = 'all'

export default function MyStoriesContainer() {
  const router = useRouter()
  const { data: stories, error, loading, reload } = S.useMyStories()
  // Azure Boards: one quiet sync when the page opens (throttled server-side), and the button forces one.
  const boards = S.useBoardsSync({ auto: true, onSynced: reload })
  const [status, setStatus] = useState<string>(ALL)
  const columns = useMemo(() => S.storyColumns({ withProject: true }), [])

  const all = stories ?? []
  const shown = status === ALL ? all : all.filter((s) => s.status === status)
  const count = (st: S.StoryStatus): number => all.filter((s) => s.status === st).length
  const stats: UI.StatItem[] = [
    { label: 'Assigned to you', value: all.length, footer: { title: 'Across all your projects' } },
    { label: 'In progress', value: count('in_progress'), badge: { label: 'Active', icon: <Timer />, variant: 'warning' }, footer: { title: 'Run the workflow on these in VS Code' } },
    { label: 'In review', value: count('in_review'), footer: { title: 'Waiting for a lead to sign off' } },
    {
      label: 'Blocked',
      value: all.filter((s) => s.isBlocked).length,
      badge: { label: 'Needs help', icon: <CircleAlert />, variant: 'destructive' },
      footer: { title: 'Flagged on the story page' },
    },
  ]

  return (
    <>
      <UI.PageHeader
        title="My stories"
        description="Stories assigned to you. Pick up more from a project's board, here or in VS Code."
        actions={<S.BoardsSyncButton boards={boards} />}
      />
      <S.BoardsSyncWarnings warnings={boards.warnings} />
      {error ? <UI.ErrorAlert message={error.message} /> : null}
      {loading && !stories ? (
        <UI.Skeleton className="h-36 rounded-xl" />
      ) : (
        <UI.StatCards items={stats} />
      )}
      {stories && stories.length === 0 ? (
        <UI.EmptyState icon={<ListTodo />} title="Nothing assigned to you" description="Open a project's board and pick up a story that's ready." />
      ) : stories ? (
        <UI.DataTable
          columns={columns}
          data={shown}
          searchColumn="title"
          searchPlaceholder="Search your stories…"
          onRowClick={(s) => router.push(`/projects/${s.projectKey}/stories/${s.number}`)}
          initialSorting={[{ id: 'status', desc: false }]}
          toolbar={
            <UI.Select value={status} onValueChange={setStatus}>
              <UI.SelectTrigger className="w-40" aria-label="Status">
                <UI.SelectValue />
              </UI.SelectTrigger>
              <UI.SelectContent>
                <UI.SelectItem value={ALL}>All statuses</UI.SelectItem>
                {S.STORY_STATUSES.map((st) => (
                  <UI.SelectItem key={st} value={st}>
                    {S.STORY_STATUS_LABELS[st]}
                  </UI.SelectItem>
                ))}
              </UI.SelectContent>
            </UI.Select>
          }
        />
      ) : null}
    </>
  )
}
