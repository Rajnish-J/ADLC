'use client'

// One memory item: kind, title, content, where it came from — and what the viewer may do with it (promote a
// story item to project memory; a lead accepts or rejects proposals, pins, archives).

import { useState } from 'react'
import Link from 'next/link'
import { Archive, ArrowUpRight, BookText, Check, FileCode2, History, MoreHorizontal, Pin, PinOff, X } from 'lucide-react'
import type { MemoryItem } from '@sdlc/contracts'
import { AppError } from '@/appError'
import * as UI from '@/imports/UI.imports'
import { archiveMemory, decideMemory, promoteMemory, updateMemory } from '@/service/memory.service'
import MemoryContent from './MemoryContent'
import ProfileHistorySheet from './profile/ProfileHistorySheet'
import { KIND_META, profileHeadline, profileVersionOf, SOURCE_LABEL } from './memory-meta'

interface Props {
  item: MemoryItem
  projectKey: string
  /** Show which story the item belongs to / came from. */
  showStory?: boolean
  compact?: boolean
  onChanged?: () => void
}

function promotionBadge(item: MemoryItem) {
  if (!item.promotion) return null
  if (item.promotion.status === 'accepted') return <UI.Badge variant="success">In project memory</UI.Badge>
  if (item.promotion.status === 'proposed') return <UI.Badge variant="warning">Proposed for project</UI.Badge>
  if (item.promotion.status === 'rejected') return <UI.Badge variant="outline">Not accepted</UI.Badge>
  return null
}

function RejectDialog({ open, onOpenChange, onReject }: { open: boolean; onOpenChange: (v: boolean) => void; onReject: (comment: string) => void }) {
  const [comment, setComment] = useState('')
  return (
    <UI.Dialog open={open} onOpenChange={onOpenChange}>
      <UI.DialogContent>
        <UI.DialogHeader>
          <UI.DialogTitle>Reject this proposal?</UI.DialogTitle>
          <UI.DialogDescription>It stays in the story’s memory; it just won’t be shared with the whole project.</UI.DialogDescription>
        </UI.DialogHeader>
        <UI.Field>
          <UI.FieldLabel htmlFor="reject-comment">Why (optional)</UI.FieldLabel>
          <UI.Textarea id="reject-comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="e.g. Too specific to this story" maxLength={1000} />
        </UI.Field>
        <UI.DialogFooter>
          <UI.Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </UI.Button>
          <UI.Button variant="destructive" onClick={() => onReject(comment.trim())}>
            Reject
          </UI.Button>
        </UI.DialogFooter>
      </UI.DialogContent>
    </UI.Dialog>
  )
}

export default function MemoryItemCard({ item, projectKey, showStory, compact, onChanged }: Props) {
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const meta = KIND_META[item.kind]
  const profileVersion = profileVersionOf(item)
  const Icon = profileVersion !== null ? BookText : meta.icon
  const { actions } = item
  const hasMenu = actions.canPromote || actions.canPin || actions.canArchive

  const run = async (action: () => Promise<MemoryItem>, done: (m: MemoryItem) => string) => {
    setBusy(true)
    try {
      const result = await action()
      UI.toast.success(done(result))
      onChanged?.()
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <UI.Item variant="outline" className={UI.cn('items-start', item.status === 'archived' && 'opacity-60')}>
      <UI.ItemMedia variant="icon">
        <Icon />
      </UI.ItemMedia>
      <UI.ItemContent className="min-w-0 gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {profileVersion !== null ? (
            <UI.Badge variant="default">
              Project profile · v{profileVersion}
            </UI.Badge>
          ) : (
            <UI.Badge variant={meta.variant}>{meta.label}</UI.Badge>
          )}
          {item.pinned ? (
            <UI.Badge variant="secondary">
              <Pin /> Pinned
            </UI.Badge>
          ) : null}
          {item.scope === 'project' && item.status === 'proposed' ? <UI.Badge variant="warning">Proposed</UI.Badge> : null}
          {item.status === 'rejected' ? <UI.Badge variant="outline">Rejected</UI.Badge> : null}
          {item.status === 'archived' ? <UI.Badge variant="outline">Archived</UI.Badge> : null}
          {promotionBadge(item)}
          {item.runId ? (
            <Link href={`/projects/${projectKey}/workflow/runs/${item.runId}`} className="text-xs text-primary hover:underline">
              {SOURCE_LABEL.run}
            </Link>
          ) : SOURCE_LABEL[item.source] && profileVersion === null ? (
            <span className="text-xs text-muted-foreground">{SOURCE_LABEL[item.source]}</span>
          ) : null}
          {item.usedByRuns ? (
            <span className="text-xs text-muted-foreground" title="Agent runs that were given this item">
              · used by {item.usedByRuns} run{item.usedByRuns === 1 ? '' : 's'}
            </span>
          ) : null}
          {showStory && item.storyKey ? (
            <Link href={`/projects/${projectKey}/stories/${item.storyNumber}`} className="font-mono text-xs text-primary hover:underline" title={item.storyTitle ?? undefined}>
              {item.storyKey}
            </Link>
          ) : null}
        </div>
        <UI.ItemTitle className="text-sm leading-snug">{item.title}</UI.ItemTitle>
        {profileVersion !== null && !compact ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">{profileHeadline(item.content)}</p>
            <p className="text-xs text-muted-foreground">
              {item.status === 'archived'
                ? `An earlier version of the project profile${item.decisionComment ? ` — ${item.decisionComment.toLowerCase()}` : ''}.`
                : 'Written by the Project profiler from the repository and given to every agent run. Regenerating it adds a new version; this one moves to Archived.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <ProfileHistorySheet
                projectKey={projectKey}
                initialVersion={profileVersion}
                trigger={
                  <UI.Button size="sm" variant="ghost">
                    <History /> {item.status === 'archived' ? `View v${profileVersion}` : 'All versions'}
                  </UI.Button>
                }
              />
            </div>
          </div>
        ) : !compact ? (
          <MemoryContent text={item.content} />
        ) : null}
        {item.fileRefs.length && !compact ? (
          <div className="flex flex-wrap gap-1.5">
            {item.fileRefs.map((f) => (
              <span key={`${f.path}:${f.startLine ?? ''}`} className="inline-flex items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                <FileCode2 className="size-3" />
                {f.path}
                {f.startLine ? `:${f.startLine}${f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : ''}` : ''}
              </span>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {item.author?.displayName ?? 'Platform'} · <span title={UI.dateTime(item.createdAt)}>{UI.relativeTime(item.createdAt)}</span>
          {item.decidedBy && item.scope === 'project' && item.status !== 'proposed' && profileVersion === null ? (
            <>
              {' '}
              · {item.status === 'rejected' ? 'rejected' : 'accepted'} by {item.decidedBy.displayName}
              {item.decisionComment ? ` — “${item.decisionComment}”` : ''}
            </>
          ) : null}
        </p>
        {actions.canDecide ? (
          <div className="mt-1 flex gap-2">
            <UI.Button size="sm" disabled={busy} onClick={() => run(() => decideMemory(projectKey, item.id, { accept: true }), () => 'Added to project memory')}>
              <Check /> Accept
            </UI.Button>
            <UI.Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
              <X /> Reject
            </UI.Button>
          </div>
        ) : null}
      </UI.ItemContent>
      {hasMenu ? (
        <UI.ItemActions>
          <UI.DropdownMenu>
            <UI.DropdownMenuTrigger asChild>
              <UI.Button variant="ghost" size="icon-sm" disabled={busy} aria-label="Memory actions">
                <MoreHorizontal />
              </UI.Button>
            </UI.DropdownMenuTrigger>
            <UI.DropdownMenuContent align="end">
              {actions.canPromote ? (
                <UI.DropdownMenuItem
                  onSelect={() =>
                    run(
                      () => promoteMemory(projectKey, item.id),
                      (m) => (m.status === 'accepted' ? 'Added to project memory' : 'Proposed for project memory — a lead will review it'),
                    )
                  }
                >
                  <ArrowUpRight /> Promote to project memory
                </UI.DropdownMenuItem>
              ) : null}
              {actions.canPin ? (
                <UI.DropdownMenuItem onSelect={() => run(() => updateMemory(projectKey, item.id, { pinned: !item.pinned }), (m) => (m.pinned ? 'Pinned — every agent gets it' : 'Unpinned'))}>
                  {item.pinned ? <PinOff /> : <Pin />} {item.pinned ? 'Unpin' : 'Pin for every agent'}
                </UI.DropdownMenuItem>
              ) : null}
              {actions.canArchive ? (
                <>
                  <UI.DropdownMenuSeparator />
                  <UI.DropdownMenuItem onSelect={() => run(() => archiveMemory(projectKey, item.id), () => 'Archived')}>
                    <Archive /> Archive
                  </UI.DropdownMenuItem>
                </>
              ) : null}
            </UI.DropdownMenuContent>
          </UI.DropdownMenu>
        </UI.ItemActions>
      ) : null}
      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        onReject={(comment) => {
          setRejecting(false)
          void run(() => decideMemory(projectKey, item.id, { accept: false, comment: comment || undefined }), () => 'Proposal rejected')
        }}
      />
    </UI.Item>
  )
}
