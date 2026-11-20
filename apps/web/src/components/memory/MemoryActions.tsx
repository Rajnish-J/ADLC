'use client'

// What can be done with a memory item — shared by the memory table's row menu and the item's details sheet:
// accept / reject a proposal (leads), promote a story item to project memory, pin / unpin, archive, and for the
// project profile's item, open the profile. Each action is offered only when the item's `actions` allow it (the API
// checks again).

import { useState, type ReactNode } from 'react'
import { Archive, ArrowUpRight, BookText, Check, Eye, MoreHorizontal, Pin, PinOff, X } from 'lucide-react'
import type { MemoryItem } from '@sdlc/contracts'
import { AppError } from '@/appError'
import * as UI from '@/imports/UI.imports'
import { archiveMemory, decideMemory, promoteMemory, updateMemory } from '@/service/memory.service'
import { profileVersionOf } from './memory-meta'

function RejectDialog({ item, onOpenChange, onReject }: { item: MemoryItem | null; onOpenChange: (open: boolean) => void; onReject: (comment: string) => void }) {
  const [comment, setComment] = useState('')
  return (
    <UI.Dialog
      open={item !== null}
      onOpenChange={(open) => {
        onOpenChange(open)
        if (!open) setComment('')
      }}
    >
      <UI.DialogContent>
        <UI.DialogHeader>
          <UI.DialogTitle>Reject “{item?.title}”?</UI.DialogTitle>
          <UI.DialogDescription>It won’t be shared with the whole project. A story item stays in the story’s memory.</UI.DialogDescription>
        </UI.DialogHeader>
        <UI.Field>
          <UI.FieldLabel htmlFor="memory-reject-comment">Why (optional)</UI.FieldLabel>
          <UI.Textarea id="memory-reject-comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="e.g. Too specific to this story" maxLength={1000} />
        </UI.Field>
        <UI.DialogFooter>
          <UI.Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </UI.Button>
          <UI.Button
            variant="destructive"
            onClick={() => {
              onReject(comment.trim())
              setComment('')
            }}
          >
            Reject
          </UI.Button>
        </UI.DialogFooter>
      </UI.DialogContent>
    </UI.Dialog>
  )
}

export interface MemoryActions {
  busy: boolean
  accept: (item: MemoryItem) => void
  /** Opens the reject dialog. */
  reject: (item: MemoryItem) => void
  promote: (item: MemoryItem) => void
  togglePin: (item: MemoryItem) => void
  archive: (item: MemoryItem) => void
  /** Render once (the reject dialog). */
  dialogs: ReactNode
}

export function useMemoryActions(projectKey: string, onChanged?: () => void): MemoryActions {
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState<MemoryItem | null>(null)

  const run = async (action: () => Promise<MemoryItem>, done: (m: MemoryItem) => string): Promise<void> => {
    setBusy(true)
    try {
      UI.toast.success(done(await action()))
      onChanged?.()
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return {
    busy,
    accept: (item) => void run(() => decideMemory(projectKey, item.id, { accept: true }), () => 'Added to project memory'),
    reject: setRejecting,
    promote: (item) =>
      void run(
        () => promoteMemory(projectKey, item.id),
        (m) => (m.status === 'accepted' ? 'Added to project memory' : 'Proposed for project memory — a lead will review it'),
      ),
    togglePin: (item) => void run(() => updateMemory(projectKey, item.id, { pinned: !item.pinned }), (m) => (m.pinned ? 'Pinned — every agent gets it' : 'Unpinned')),
    archive: (item) => void run(() => archiveMemory(projectKey, item.id), () => 'Archived'),
    dialogs: (
      <RejectDialog
        item={rejecting}
        onOpenChange={(open) => !open && setRejecting(null)}
        onReject={(comment) => {
          const item = rejecting
          setRejecting(null)
          if (item) void run(() => decideMemory(projectKey, item.id, { accept: false, comment: comment || undefined }), () => 'Proposal rejected')
        }}
      />
    ),
  }
}

/** The row menu: details first, then everything the item allows. Clicks never reach the row (it opens details). */
export function MemoryActionsMenu({ item, actions, onView }: { item: MemoryItem; actions: MemoryActions; onView: (item: MemoryItem) => void }) {
  const a = item.actions
  const isProfile = profileVersionOf(item) !== null
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <UI.DropdownMenu>
      <UI.DropdownMenuTrigger asChild onClick={stop}>
        <UI.Button variant="ghost" size="icon-sm" disabled={actions.busy} aria-label={`Actions for ${item.title}`}>
          <MoreHorizontal />
        </UI.Button>
      </UI.DropdownMenuTrigger>
      <UI.DropdownMenuContent align="end" onClick={stop}>
        <UI.DropdownMenuItem onSelect={() => onView(item)}>
          {isProfile ? <BookText /> : <Eye />} {isProfile ? 'Open profile' : 'View details'}
        </UI.DropdownMenuItem>
        {a.canDecide ? (
          <>
            <UI.DropdownMenuSeparator />
            <UI.DropdownMenuItem onSelect={() => actions.accept(item)}>
              <Check /> Accept into project memory
            </UI.DropdownMenuItem>
            <UI.DropdownMenuItem onSelect={() => actions.reject(item)}>
              <X /> Reject…
            </UI.DropdownMenuItem>
          </>
        ) : null}
        {a.canPromote || a.canPin ? <UI.DropdownMenuSeparator /> : null}
        {a.canPromote ? (
          <UI.DropdownMenuItem onSelect={() => actions.promote(item)}>
            <ArrowUpRight /> Promote to project memory
          </UI.DropdownMenuItem>
        ) : null}
        {a.canPin ? (
          <UI.DropdownMenuItem onSelect={() => actions.togglePin(item)}>
            {item.pinned ? <PinOff /> : <Pin />} {item.pinned ? 'Unpin' : 'Pin for every agent'}
          </UI.DropdownMenuItem>
        ) : null}
        {a.canArchive ? (
          <>
            <UI.DropdownMenuSeparator />
            <UI.DropdownMenuItem variant="destructive" onSelect={() => actions.archive(item)}>
              <Archive /> Archive
            </UI.DropdownMenuItem>
          </>
        ) : null}
      </UI.DropdownMenuContent>
    </UI.DropdownMenu>
  )
}
