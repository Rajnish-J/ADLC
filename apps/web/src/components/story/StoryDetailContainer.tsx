'use client'

import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Code2 } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as M from '@/imports/memory.imports'
import * as S from '@/imports/story.imports'
import * as W from '@/imports/work.imports'
import { LatestRunChip } from '@/components/work/LatestRunChip'
import StoryTasks from './StoryTasks'

const TABS = ['overview', 'memory', 'code', 'activity'] as const
type Tab = (typeof TABS)[number]

/** `story/PAY-2-refund-api-endpoint` — the branch the extension creates for the story (mirrors storyFormat.ts). */
function branchName(key: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return `story/${key}${slug ? `-${slug}` : ''}`
}

function Count({ n }: { n: number }) {
  return n ? <span className="ml-1 rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">{n}</span> : null
}

function Detail({ project, number }: { project: S.ProjectDetail; number: number }) {
  const { data: story, error, loading, setData, reload } = S.useStory(project.key, number)
  const { busy, save } = S.useStorySave(setData, reload)
  const work = W.useStoryWork(project.key, number)
  const memory = M.useStoryMemory(project.key, number)
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const requested = params.get('tab')
  const tab: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : 'overview'
  const setTab = (next: string) => router.replace(next === 'overview' ? pathname : `${pathname}?tab=${next}`, { scroll: false })

  if (error) return <UI.ErrorAlert title={error.status === 404 ? 'Story not found' : 'Could not load the story'} message={error.message} />
  if (loading || !story) {
    return (
      <div className="flex flex-col gap-6">
        <UI.Skeleton className="h-14 w-2/3" />
        <div className="grid gap-6 @4xl/main:grid-cols-[1fr_340px]">
          <UI.Skeleton className="h-96 rounded-xl" />
          <UI.Skeleton className="h-72 rounded-xl" />
        </div>
      </div>
    )
  }

  const memoryCount = (memory.data ?? []).filter((m) => m.status !== 'archived').length
  const workCount = (work.data?.commits.length ?? 0) + (work.data?.runs.length ?? 0)
  const liveCount = (work.data?.workspaces ?? []).filter((w) => W.isLive(w) && w.files.length > 0).length

  return (
    <>
      <UI.PageHeader
        leading={<span className="mt-1 rounded-md bg-accent px-2 py-1 font-mono text-xs font-semibold text-accent-foreground">{story.key}</span>}
        title={story.title}
        badges={
          <>
            <UI.StatusBadge status={story.status} />
            <UI.PriorityBadge priority={story.priority} />
            {story.isBlocked ? <UI.BlockedBadge reason={story.blockedReason} /> : null}
            <S.StoryExternalBadge story={story} />
            <S.DueDateChip story={story} />
            <S.LabelChips labels={story.labels} max={6} />
            <span className="text-xs text-muted-foreground">
              <LatestRunChip projectKey={story.projectKey} run={story.latestRun} />
            </span>
            {liveCount ? (
              <UI.Badge variant="success">
                <span className="size-1.5 animate-pulse rounded-full bg-current" /> {liveCount} working now
              </UI.Badge>
            ) : null}
          </>
        }
      />

      <div className="grid gap-6 @4xl/main:grid-cols-[minmax(0,1fr)_340px]">
        <UI.Tabs value={tab} onValueChange={setTab} className="min-w-0 gap-4">
          <UI.TabsList>
            <UI.TabsTrigger value="overview">Overview</UI.TabsTrigger>
            <UI.TabsTrigger value="memory">
              Memory
              <Count n={memoryCount} />
            </UI.TabsTrigger>
            <UI.TabsTrigger value="code">
              Code &amp; runs
              <Count n={workCount} />
            </UI.TabsTrigger>
            <UI.TabsTrigger value="activity">Activity</UI.TabsTrigger>
          </UI.TabsList>

          <UI.TabsContent value="overview">
            <UI.Card>
              <UI.CardContent className="flex flex-col gap-6">
                {story.isBlocked ? (
                  <UI.Alert variant="destructive">
                    <UI.AlertTitle>Blocked</UI.AlertTitle>
                    <UI.AlertDescription>{story.blockedReason || 'No reason given.'}</UI.AlertDescription>
                  </UI.Alert>
                ) : null}
                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold">Story</h2>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
                    {story.description || <span className="text-muted-foreground">No description.</span>}
                  </p>
                </section>
                <UI.Separator />
                <S.AcceptanceCriteriaList story={story} onChange={setData} />
                <UI.Separator />
                <StoryTasks project={project} story={story} />
              </UI.CardContent>
            </UI.Card>
          </UI.TabsContent>

          <UI.TabsContent value="memory">
            <div className="grid gap-6 @6xl/main:grid-cols-[minmax(0,1fr)_280px]">
              <M.StoryMemoryPanel projectKey={project.key} storyNumber={story.number} canAdd={story.actions.canAddMemory} />
              <M.ProjectKnowledgeCard projectKey={project.key} />
            </div>
          </UI.TabsContent>

          <UI.TabsContent value="code">
            <W.StoryWorkPanel projectKey={project.key} storyNumber={story.number} work={work} />
          </UI.TabsContent>

          <UI.TabsContent value="activity">
            <UI.Card>
              <UI.CardContent>
                <S.StoryActivityPanel projectKey={project.key} storyNumber={story.number} />
              </UI.CardContent>
            </UI.Card>
          </UI.TabsContent>
        </UI.Tabs>

        <div className="flex flex-col gap-4">
          <UI.Card>
            <UI.CardHeader>
              <UI.CardTitle>Details</UI.CardTitle>
            </UI.CardHeader>
            <UI.CardContent>
              <S.StoryProperties story={story} project={project} busy={busy} save={save} />
            </UI.CardContent>
          </UI.Card>
          <W.DevelopmentCard work={work.data} branchName={branchName(story.key, story.title)} onOpen={() => setTab('code')} />
          <UI.Card>
            <UI.CardHeader>
              <UI.CardTitle>Actions</UI.CardTitle>
            </UI.CardHeader>
            <UI.CardContent>
              <S.StoryActions story={story} onChange={setData} />
            </UI.CardContent>
          </UI.Card>
          <UI.Item variant="muted" size="sm">
            <UI.ItemMedia variant="icon">
              <Code2 />
            </UI.ItemMedia>
            <UI.ItemContent>
              <UI.ItemTitle>Work on it in VS Code</UI.ItemTitle>
              <UI.ItemDescription className="line-clamp-none">
                Start it (or one of its tasks) above in the harness you have installed, or pick it up from{' '}
                <span className="font-medium text-foreground">Platform Stories</span> — edits, commits and{' '}
                <Link href={`/projects/${project.key}/workflow`} className="text-primary underline-offset-4 hover:underline">
                  workflow
                </Link>{' '}
                runs on it show up here live.
              </UI.ItemDescription>
            </UI.ItemContent>
          </UI.Item>
        </div>
      </div>
    </>
  )
}

export default function StoryDetailContainer() {
  const { number } = useParams<{ number: string }>()
  return <S.ProjectShell header={false}>{(project) => <Detail project={project} number={Number(number)} />}</S.ProjectShell>
}
