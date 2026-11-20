'use client'

// Commits on the story branch, newest first. Each expands to its message body and files, with the diff a click away.

import { ChevronRight, FileDiff } from 'lucide-react'
import type { StoryCommit } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import ChangedFiles from './ChangedFiles'
import DiffSheet from './DiffSheet'

export default function CommitList({ projectKey, storyNumber, commits }: { projectKey: string; storyNumber: number; commits: StoryCommit[] }) {
  if (commits.length === 0) return <p className="text-sm text-muted-foreground">No commits on the story branch yet.</p>
  return (
    <div className="divide-y rounded-xl border">
      {commits.map((c) => {
        const [subject, ...rest] = c.message.split('\n')
        const body = rest.join('\n').trim()
        return (
          <UI.Collapsible key={c.sha} className="group/commit">
            <UI.CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/50">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/commit:rotate-90" />
              <span className="shrink-0 font-mono text-xs text-primary">{c.sha.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate">{subject}</span>
              <span className="hidden shrink-0 font-mono text-xs @xl/main:inline">
                <span className="text-success">+{c.additions}</span> <span className="text-destructive">−{c.deletions}</span>
              </span>
              <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground @2xl/main:flex" title={UI.dateTime(c.committedAt)}>
                <UI.UserAvatar name={c.authorName || c.reportedBy?.displayName || '?'} className="size-5" />
                {UI.relativeTime(c.committedAt)}
              </span>
            </UI.CollapsibleTrigger>
            <UI.CollapsibleContent className="flex flex-col gap-3 border-t bg-muted/20 px-4 py-3 pl-11">
              <p className="text-xs text-muted-foreground">
                {c.authorName} &lt;{c.authorEmail}&gt; · {UI.dateTime(c.committedAt)} · <span className="font-mono">{c.branch}</span>
              </p>
              {body ? <pre className="font-sans text-sm whitespace-pre-wrap text-foreground/90">{body}</pre> : null}
              <ChangedFiles files={c.files} />
              {c.hasPatch ? (
                <DiffSheet
                  projectKey={projectKey}
                  storyNumber={storyNumber}
                  target={{ kind: 'commit', sha: c.sha }}
                  title={subject}
                  description={
                    <span className="font-mono">
                      {c.sha.slice(0, 12)} · {c.authorName}
                    </span>
                  }
                  trigger={
                    <UI.Button size="sm" variant="outline" className="self-start">
                      <FileDiff /> View diff
                    </UI.Button>
                  }
                />
              ) : null}
            </UI.CollapsibleContent>
          </UI.Collapsible>
        )
      })}
    </div>
  )
}
