'use client'

// One memory item in full, opened from the memory table: its whole text, where it came from (run, story, promotion,
// the project profile), who wrote and decided it, how often runs were given it — and what the viewer may do with it.

import Link from 'next/link'
import type { ReactNode } from 'react'
import { Archive, ArrowUpRight, Check, FileCode2, Pin, PinOff, X } from 'lucide-react'
import type { MemoryItem } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import type { MemoryActions } from './MemoryActions'
import MemoryContent from './MemoryContent'
import { KIND_META, profileVersionOf, SOURCE_LABEL } from './memory-meta'
import ProfileVersionPanel from './profile/ProfileVersionPanel'

const STATUS: Record<MemoryItem['status'], { label: string; variant: 'success' | 'warning' | 'outline' }> = {
  accepted: { label: 'Accepted', variant: 'success' },
  proposed: { label: 'Proposed', variant: 'warning' },
  rejected: { label: 'Rejected', variant: 'outline' },
  archived: { label: 'Archived', variant: 'outline' },
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

interface Props {
  item: MemoryItem | null
  projectKey: string
  actions: MemoryActions
  onOpenChange: (open: boolean) => void
}

export default function MemoryDetailSheet({ item, projectKey, actions, onOpenChange }: Props) {
  const key = encodeURIComponent(projectKey)
  return (
    <UI.Sheet open={item !== null} onOpenChange={onOpenChange}>
      <UI.SheetContent
        className={UI.cn('gap-0 data-[side=right]:w-full', item && profileVersionOf(item) !== null ? 'data-[side=right]:sm:max-w-4xl' : 'data-[side=right]:sm:max-w-2xl')}
      >
        {item ? <Body item={item} projectKey={projectKey} keyParam={key} actions={actions} /> : null}
      </UI.SheetContent>
    </UI.Sheet>
  )
}

function Body({ item, projectKey, keyParam, actions }: { item: MemoryItem; projectKey: string; keyParam: string; actions: MemoryActions }) {
  const meta = KIND_META[item.kind]
  const profileVersion = profileVersionOf(item)
  const a = item.actions
  const status = STATUS[item.status]
  const source = item.runId ? (
    <Link href={`/projects/${keyParam}/workflow/runs/${item.runId}`} className="text-primary hover:underline">
      {SOURCE_LABEL.run}
    </Link>
  ) : (
    (SOURCE_LABEL[item.source] ?? 'Written by a person')
  )

  return (
    <>
      <UI.SheetHeader className="border-b">
        <div className="flex flex-wrap items-center gap-1.5">
          {profileVersion !== null ? <UI.Badge>Project profile · v{profileVersion}</UI.Badge> : <UI.Badge variant={meta.variant}>{meta.label}</UI.Badge>}
          <UI.Badge variant={status.variant}>{status.label}</UI.Badge>
          {item.pinned ? (
            <UI.Badge variant="secondary">
              <Pin /> Pinned
            </UI.Badge>
          ) : null}
          <span className="text-xs text-muted-foreground">{item.scope === 'story' ? 'Story memory' : 'Project memory'}</span>
        </div>
        <UI.SheetTitle className="text-base leading-snug">{item.title}</UI.SheetTitle>
        <UI.SheetDescription>{profileVersion !== null ? 'Written by the Project profiler from the repository; the current version is given to every agent run.' : `${meta.hint}.`}</UI.SheetDescription>
      </UI.SheetHeader>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {profileVersion !== null ? (
          // The profile itself: fixed height, the section scrolls inside.
          <div className="h-[34rem]">
            <ProfileVersionPanel projectKey={projectKey} version={profileVersion} />
          </div>
        ) : (
          <MemoryContent text={item.content || 'No details.'} clampAt={Number.MAX_SAFE_INTEGER} />
        )}

        <dl className="mt-5 divide-y border-t">
          <Row label="Source">{source}</Row>
          {item.storyKey ? (
            <Row label="Story">
              <Link href={`/projects/${keyParam}/stories/${item.storyNumber}?tab=memory`} className="font-mono text-primary hover:underline">
                {item.storyKey}
              </Link>
              {item.storyTitle ? <span className="text-muted-foreground"> — {item.storyTitle}</span> : null}
            </Row>
          ) : null}
          {item.promotion ? (
            <Row label="In project memory">{item.promotion.status === 'accepted' ? 'Yes' : item.promotion.status === 'proposed' ? 'Proposed, waiting for a lead' : 'Not accepted'}</Row>
          ) : null}
          <Row label="Written by">
            {item.author?.displayName ?? 'Platform'} · <span title={UI.dateTime(item.createdAt)}>{UI.relativeTime(item.createdAt)}</span>
          </Row>
          {item.decidedBy ? (
            <Row label={item.status === 'rejected' ? 'Rejected by' : 'Accepted by'}>
              {item.decidedBy.displayName}
              {item.decidedAt ? <span className="text-muted-foreground"> · {UI.relativeTime(item.decidedAt)}</span> : null}
            </Row>
          ) : null}
          {item.decisionComment ? <Row label="Comment">“{item.decisionComment}”</Row> : null}
          {item.updatedAt !== item.createdAt ? <Row label="Updated">{UI.dateTime(item.updatedAt)}</Row> : null}
          <Row label="Given to runs">{item.usedByRuns ? `${item.usedByRuns} run${item.usedByRuns === 1 ? '' : 's'}` : 'Not yet'}</Row>
          {item.tags.length ? (
            <Row label="Tags">
              <span className="flex flex-wrap gap-1">
                {item.tags.map((t) => (
                  <UI.Badge key={t} variant="outline">
                    #{t}
                  </UI.Badge>
                ))}
              </span>
            </Row>
          ) : null}
          {item.fileRefs.length ? (
            <Row label="Files">
              <span className="flex flex-wrap gap-1.5">
                {item.fileRefs.map((f) => (
                  <Link
                    key={`${f.path}:${f.startLine ?? ''}`}
                    href={`/projects/${keyParam}/code?${new URLSearchParams({ path: f.path }).toString()}`}
                    className="inline-flex items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <FileCode2 className="size-3" />
                    {f.path}
                    {f.startLine ? `:${f.startLine}${f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : ''}` : ''}
                  </Link>
                ))}
              </span>
            </Row>
          ) : null}
        </dl>
      </div>

      {a.canDecide || a.canPromote || a.canPin || a.canArchive ? (
        <div className="flex flex-wrap justify-end gap-2 border-t p-4">
          {a.canArchive ? (
            <UI.Button variant="ghost" className="mr-auto text-destructive" disabled={actions.busy} onClick={() => actions.archive(item)}>
              <Archive /> Archive
            </UI.Button>
          ) : null}
          {a.canPin ? (
            <UI.Button variant="outline" disabled={actions.busy} onClick={() => actions.togglePin(item)}>
              {item.pinned ? <PinOff /> : <Pin />} {item.pinned ? 'Unpin' : 'Pin for every agent'}
            </UI.Button>
          ) : null}
          {a.canPromote ? (
            <UI.Button variant="outline" disabled={actions.busy} onClick={() => actions.promote(item)}>
              <ArrowUpRight /> Promote to project memory
            </UI.Button>
          ) : null}
          {a.canDecide ? (
            <>
              <UI.Button variant="outline" disabled={actions.busy} onClick={() => actions.reject(item)}>
                <X /> Reject
              </UI.Button>
              <UI.Button disabled={actions.busy} onClick={() => actions.accept(item)}>
                <Check /> Accept
              </UI.Button>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
