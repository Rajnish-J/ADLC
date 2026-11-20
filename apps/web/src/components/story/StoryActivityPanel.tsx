'use client'

// One story's history — moves, edits (with what changed), memory and agent runs — newest first, live, with
// "Load more" for older entries. Any project member can read it.

import { useState } from 'react'
import { describeStoryActivity, type AuditEntry } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorAlert } from '@/components/common/feedback'
import { UserAvatar } from '@/components/common/user-avatar'
import { auditedChange } from '@/hooks/common/liveFilters'
import { useApiResource } from '@/hooks/common/useApiResource'
import { listStoryActivity } from '@/service/story.service'
import { dateTime, formatDueDate, relativeTime } from '@/utils/format'

/** What happened, as a phrase after the actor's name — the same wording the VS Code Story panel uses. */
const describe = (entry: AuditEntry): string => describeStoryActivity(entry, { formatDate: (d) => formatDueDate(d) })

export default function StoryActivityPanel({ projectKey, storyNumber }: { projectKey: string; storyNumber: number }) {
  const { data, error, loading } = useApiResource(
    () => listStoryActivity(projectKey, storyNumber),
    [projectKey, storyNumber],
    auditedChange(projectKey),
  )
  const [older, setOlder] = useState<AuditEntry[]>([])
  const [more, setMore] = useState<'idle' | 'loading' | 'done'>('idle')

  if (error) return <ErrorAlert title="Could not load the activity" message={error.message} />
  if (loading && !data) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    )
  }

  const entries = [...(data ?? []), ...older.filter((o) => !(data ?? []).some((d) => d.id === o.id))]
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">Nothing has happened on this story yet.</p>

  async function loadMore(): Promise<void> {
    setMore('loading')
    const page = await listStoryActivity(projectKey, storyNumber, entries[entries.length - 1].id).catch(() => [])
    setOlder((o) => [...o, ...page])
    setMore(page.length < 50 ? 'done' : 'idle')
  }

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col">
        {entries.map((e, i) => (
          <li key={e.id} className="relative flex gap-3 pb-5 last:pb-0">
            {i < entries.length - 1 ? <span className="absolute top-7 bottom-0 left-3 w-px bg-border" aria-hidden /> : null}
            <UserAvatar name={e.actor?.displayName ?? 'System'} className="size-6 shrink-0" />
            <div className="min-w-0 flex-1 text-sm leading-snug">
              <span className="font-medium">{e.actor?.displayName ?? 'System'}</span> <span className="text-foreground/80">{describe(e)}</span>
              <div className="mt-0.5 text-xs text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>{relativeTime(e.createdAt)}</span>
                  </TooltipTrigger>
                  <TooltipContent>{dateTime(e.createdAt)}</TooltipContent>
                </Tooltip>
                {e.via !== 'web' ? ` · via ${e.via === 'extension' ? 'VS Code' : e.via}` : null}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {entries.length >= 50 && more !== 'done' ? (
        <Button variant="outline" size="sm" className="self-start" disabled={more === 'loading'} onClick={() => void loadMore()}>
          {more === 'loading' ? <Spinner /> : null}
          Load older activity
        </Button>
      ) : null}
    </div>
  )
}
