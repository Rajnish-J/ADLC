'use client'

// Who is working on the story right now: each developer's uncommitted changes, as reported from their VS Code.

import { FileDiff, GitBranch } from 'lucide-react'
import type { WorkspaceSnapshot } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import ChangedFiles from './ChangedFiles'
import DiffSheet from './DiffSheet'

/** A snapshot this fresh means the developer's VS Code is reporting right now. */
export const LIVE_MS = 2 * 60_000
export const isLive = (w: WorkspaceSnapshot): boolean => Date.now() - new Date(w.updatedAt).getTime() < LIVE_MS

export default function WorkingNow({ projectKey, storyNumber, workspaces }: { projectKey: string; storyNumber: number; workspaces: WorkspaceSnapshot[] }) {
  if (workspaces.length === 0) {
    return <p className="text-sm text-muted-foreground">Nobody has uncommitted work on this story. Developers’ changes show here while they edit on the story branch in VS Code.</p>
  }
  return (
    <div className="grid gap-3 @3xl/main:grid-cols-2">
      {workspaces.map((w) => {
        const live = isLive(w)
        return (
          <UI.Card key={w.user.id} className="gap-3 py-4">
            <UI.CardHeader className="px-4">
              <div className="flex items-center gap-2">
                <UI.UserAvatar name={w.user.displayName} />
                <UI.CardTitle className="text-sm">{w.user.displayName}</UI.CardTitle>
                <span className="relative flex size-2">
                  {live ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" /> : null}
                  <span className={UI.cn('relative inline-flex size-2 rounded-full', live ? 'bg-success' : 'bg-muted-foreground/40')} />
                </span>
                <span className="text-xs text-muted-foreground" title={UI.dateTime(w.updatedAt)}>
                  {live ? 'working now' : `last update ${UI.relativeTime(w.updatedAt)}`}
                </span>
              </div>
              <UI.CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="inline-flex items-center gap-1 font-mono">
                  <GitBranch className="size-3.5" />
                  {w.branch}
                </span>
                {w.ahead || w.behind ? (
                  <span>
                    {w.ahead} ahead · {w.behind} behind
                  </span>
                ) : null}
              </UI.CardDescription>
            </UI.CardHeader>
            <UI.CardContent className="flex flex-col gap-3 px-4">
              {w.files.length === 0 ? (
                <p className="text-sm text-muted-foreground">No uncommitted changes — everything is committed.</p>
              ) : (
                <>
                  <p className="text-sm">
                    {w.files.length} file{w.files.length === 1 ? '' : 's'} changed ·{' '}
                    <span className="font-mono text-success">+{w.additions}</span> <span className="font-mono text-destructive">−{w.deletions}</span>
                  </p>
                  <ChangedFiles files={w.files} max={8} />
                  {w.hasPatch ? (
                    <DiffSheet
                      projectKey={projectKey}
                      storyNumber={storyNumber}
                      target={{ kind: 'workspace', userId: w.user.id }}
                      title={`${w.user.displayName}’s uncommitted changes`}
                      description={`${w.branch} · updated ${UI.relativeTime(w.updatedAt)}`}
                      trigger={
                        <UI.Button size="sm" variant="outline" className="self-start">
                          <FileDiff /> View diff
                        </UI.Button>
                      }
                    />
                  ) : null}
                </>
              )}
            </UI.CardContent>
          </UI.Card>
        )
      })}
    </div>
  )
}
