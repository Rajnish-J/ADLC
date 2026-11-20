'use client'

// "Code & runs" on the story page: working now, commits, agent runs — everything reported from VS Code.

import type { StoryWork } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import type { ApiResource } from '@/hooks/common/useApiResource'
import CommitList from './CommitList'
import RunList from './RunList'
import WorkingNow from './WorkingNow'

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">
        {title} {count ? <span className="font-normal text-muted-foreground">({count})</span> : null}
      </h2>
      {children}
    </section>
  )
}

export default function StoryWorkPanel({ projectKey, storyNumber, work }: { projectKey: string; storyNumber: number; work: ApiResource<StoryWork> }) {
  if (work.error) return <UI.ErrorAlert title="Could not load code activity" message={work.error.message} />
  if (!work.data) return <UI.Skeleton className="h-64 rounded-xl" />
  const { workspaces, commits, runs } = work.data
  return (
    <div className="flex flex-col gap-8">
      <Section title="Working now">
        <WorkingNow projectKey={projectKey} storyNumber={storyNumber} workspaces={workspaces} />
      </Section>
      <Section title="Commits" count={commits.length}>
        <CommitList projectKey={projectKey} storyNumber={storyNumber} commits={commits} />
      </Section>
      <Section title="Agent runs" count={runs.length}>
        <RunList runs={runs} projectKey={projectKey} />
      </Section>
    </div>
  )
}
