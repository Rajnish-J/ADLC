'use client'

// The story page's at-a-glance development status: branch, who is working now, last commit, latest run.

import { GitBranch, GitCommitHorizontal, Workflow } from 'lucide-react'
import { RUN_STATUS_LABELS, type StoryWork } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { RUN_VARIANT } from './RunList'
import { isLive } from './WorkingNow'

export default function DevelopmentCard({ work, branchName, onOpen }: { work: StoryWork | null; branchName: string; onOpen: () => void }) {
  const live = work?.workspaces.filter(isLive) ?? []
  const lastCommit = work?.commits[0]
  const lastRun = work?.runs[0]
  const branch = live[0]?.branch ?? lastCommit?.branch ?? work?.workspaces[0]?.branch ?? branchName
  return (
    <UI.Card>
      <UI.CardHeader>
        <UI.CardTitle>Development</UI.CardTitle>
        <UI.CardAction>
          <UI.Button variant="link" size="sm" className="h-auto p-0" onClick={onOpen}>
            Code &amp; runs
          </UI.Button>
        </UI.CardAction>
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-xs" title={branch}>
            {branch}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {live.length ? (
            <>
              <UI.AvatarGroup>
                {live.map((w) => (
                  <UI.UserAvatar key={w.user.id} name={w.user.displayName} />
                ))}
              </UI.AvatarGroup>
              <span className="text-muted-foreground">
                {live.length === 1 ? `${live[0].user.displayName} is` : `${live.length} people are`} working now
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Nobody is editing right now</span>
          )}
        </div>
        <div className="flex items-start gap-2">
          <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          {lastCommit ? (
            <span className="min-w-0">
              <span className="line-clamp-1">{lastCommit.message.split('\n')[0]}</span>
              <span className="text-xs text-muted-foreground">
                {work?.commits.length} commit{work?.commits.length === 1 ? '' : 's'} · last {UI.relativeTime(lastCommit.committedAt)}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">No commits yet</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Workflow className="size-4 shrink-0 text-muted-foreground" />
          {lastRun ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{lastRun.workflowName}</span>
              <UI.Badge variant={RUN_VARIANT[lastRun.status]}>{RUN_STATUS_LABELS[lastRun.status]}</UI.Badge>
            </span>
          ) : (
            <span className="text-muted-foreground">No agent runs yet</span>
          )}
        </div>
      </UI.CardContent>
    </UI.Card>
  )
}
