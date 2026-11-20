'use client'

// The project board: status stats, filters, and the stories either as draggable columns or as a table. A card
// opens in a floating drawer (`?story=<number>`, so it can be shared and Back closes it). Updates live — a story
// picked up in VS Code moves here without a reload.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { CircleAlert, Columns3, Hand, Plus, Table2, Timer } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as S from '@/imports/story.imports'

function BoardSkeleton() {
  return (
    <div className="flex h-[calc(100svh-9rem)] min-h-105 gap-3 overflow-hidden">
      {S.STORY_STATUSES.map((s) => (
        <UI.Skeleton key={s} className="h-full min-w-60 flex-1 rounded-xl" />
      ))}
    </div>
  )
}

/** `?story=<number>` ↔ the open drawer, via the history API (no server round-trip, and Back closes it). */
function useOpenStory() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const pushed = useRef(false)
  const number = Number(searchParams.get('story')) || null

  const urlFor = useCallback(
    (n: number | null): string => {
      const params = new URLSearchParams(searchParams.toString())
      if (n === null) params.delete('story')
      else params.set('story', String(n))
      const qs = params.toString()
      return qs ? `${pathname}?${qs}` : pathname
    },
    [pathname, searchParams],
  )

  const open = useCallback(
    (story: S.Story) => {
      window.history.pushState(null, '', urlFor(story.number))
      pushed.current = true
    },
    [urlFor],
  )

  const close = useCallback(() => {
    if (pushed.current) {
      pushed.current = false
      window.history.back()
    } else {
      window.history.replaceState(null, '', urlFor(null))
    }
  }, [urlFor])

  return { number, open, close }
}

function Board({ project, view }: { project: S.ProjectDetail; view: S.BoardView }) {
  const { me } = S.useSession()
  const { data: stories, error, loading, reload, setData } = S.useStories(project.key)
  const [filters, setFilters] = useState<S.BoardFilterState>(S.NO_FILTERS)
  const [refreshing, setRefreshing] = useState(false)
  const columns = useMemo(() => S.storyColumns(), [])
  const drawer = useOpenStory()
  // Azure Boards: when the project is linked and I can pick up stories, sync my work items once on open.
  const boardsLink = S.useProjectBoards(project.key)
  const linked = !!boardsLink.data?.settings?.enabled && project.permissions.includes('story.pickup')
  const boards = S.useBoardsSync({ projectKey: project.key, auto: linked, onSynced: reload })

  // Async results (a move, a pick-up) apply to the latest list, not the one they started from.
  const latest = useRef<S.Story[]>([])
  useEffect(() => {
    latest.current = stories ?? []
  }, [stories])

  const replace = useCallback(
    (next: S.Story[]) => {
      latest.current = next
      setData(next)
    },
    [setData],
  )
  const upsert = useCallback((story: S.Story) => replace(latest.current.map((s) => (s.id === story.id ? story : s))), [replace])

  const drop = useCallback(
    async (story: S.Story, to: S.StoryStatus, position: S.DropPosition, rank: number) => {
      replace(latest.current.map((s) => (s.id === story.id ? S.optimisticMove(story, to, me?.user ?? null, rank) : s)))
      try {
        upsert(await S.performMove(story, to, position))
        const done = S.moveToast(story, to)
        if (done) UI.toast.success(done)
      } catch (err) {
        upsert(story)
        UI.toast.error(err instanceof S.AppError ? err.message : 'Could not move the story.')
        if (err instanceof S.AppError && err.status === 409) void reload()
      }
    },
    [me, replace, upsert, reload],
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await reload()
    } finally {
      setRefreshing(false)
    }
  }, [reload])

  if (error) return <UI.ErrorAlert message={error.message} />
  if (loading && !stories) return <BoardSkeleton />

  const all = stories ?? []
  const shown = S.applyFilters(all, filters, me?.user.id)
  const labels = S.boardLabels(all)
  const count = (status: S.StoryStatus): number => all.filter((s) => s.status === status).length
  const blocked = all.filter((s) => s.isBlocked).length
  const stats: UI.StatItem[] = [
    { label: 'Ready to pick up', value: count('ready'), badge: { label: 'Ready', icon: <Hand /> }, footer: { title: `${count('draft')} still in draft` } },
    { label: 'In progress', value: count('in_progress'), badge: { label: 'Active', icon: <Timer />, variant: 'warning' }, footer: { title: 'Being built with the agents' } },
    { label: 'In review', value: count('in_review'), footer: { title: 'Waiting for a lead to sign off' } },
    {
      label: 'Done',
      value: count('done'),
      badge: blocked > 0 ? { label: `${blocked} blocked`, icon: <CircleAlert />, variant: 'destructive' } : undefined,
      footer: { title: `${all.length} stories in total` },
    },
  ]
  const openStory = drawer.number === null ? null : (all.find((s) => s.number === drawer.number) ?? null)

  return (
    <>
      <UI.StatCards items={stats} />
      <S.BoardFilters
        project={project}
        filters={filters}
        onFilters={setFilters}
        labels={labels}
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        actions={linked ? <S.BoardsSyncButton boards={boards} /> : null}
      />
      <S.BoardsSyncWarnings warnings={boards.warnings} />
      {view === 'board' ? (
        <S.StoryBoardDnd stories={shown} onDrop={(s, to, at, rank) => void drop(s, to, at, rank)} onOpen={drawer.open} onChange={upsert} />
      ) : (
        <UI.DataTable
          columns={columns}
          data={shown}
          onRowClick={drawer.open}
          emptyMessage="No stories match these filters."
          initialSorting={[{ id: 'status', desc: false }]}
        />
      )}
      <S.StoryDrawer
        project={project}
        number={drawer.number}
        story={openStory}
        loading={loading}
        labelSuggestions={labels}
        onClose={drawer.close}
        onChange={upsert}
        reload={reload}
      />
    </>
  )
}

export default function BoardContainer() {
  const [creating, setCreating] = useState(false)
  const [view, setView] = useState<S.BoardView>('board')
  return (
    <S.ProjectShell
      actions={(project) => (
        <>
          <UI.ToggleGroup
            type="single"
            variant="outline"
            value={view}
            onValueChange={(v) => v && setView(v as S.BoardView)}
            aria-label="View"
          >
            <UI.ToggleGroupItem value="list" aria-label="Table view">
              <Table2 /> Table
            </UI.ToggleGroupItem>
            <UI.ToggleGroupItem value="board" aria-label="Board view">
              <Columns3 /> Board
            </UI.ToggleGroupItem>
          </UI.ToggleGroup>
          {project.permissions.includes('story.create') ? (
            <>
              <UI.Button onClick={() => setCreating(true)}>
                <Plus /> New story
              </UI.Button>
              <S.NewStorySheet project={project} open={creating} onOpenChange={setCreating} />
            </>
          ) : null}
        </>
      )}
    >
      {(project) => (
        <Suspense fallback={<BoardSkeleton />}>
          <Board project={project} view={view} />
        </Suspense>
      )}
    </S.ProjectShell>
  )
}
