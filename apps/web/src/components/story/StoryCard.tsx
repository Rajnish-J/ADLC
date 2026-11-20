'use client'

// A story on the board: key and state up top, the title, then priority, criteria progress, due date and labels,
// and who raised it and who is on it. Click (or Enter) opens the story drawer; drag moves it within its column or
// to another one. "Pick up" is a real button — it claims the story without opening it.

import { useState, type ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Hand } from 'lucide-react'
import { toast } from 'sonner'
import type { Story } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PriorityBadge } from '@/components/common/story-badges'
import { UserAvatar } from '@/components/common/user-avatar'
import { AppError } from '@/appError'
import { LatestRunTag } from '@/components/work/LatestRunChip'
import { cn } from '@/lib/utils'
import { pickUpStory } from '@/service/story.service'
import { shortAge } from '@/utils/format'
import { DueDateChip, LabelChips } from './StoryChips'
import StoryStatePill from './StoryStatePill'
import { StoryExternalBadge } from './StoryExternalBadge'

function Assignee({ story }: { story: Story }) {
  if (!story.assignee) return <span className="shrink-0 italic">Unassigned</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0">
          <UserAvatar name={story.assignee.displayName} className="size-6" />
        </span>
      </TooltipTrigger>
      <TooltipContent>Assigned to {story.assignee.displayName}</TooltipContent>
    </Tooltip>
  )
}

function PickUpButton({ story, onChange }: { story: Story; onChange: (story: Story) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="xs"
      variant="outline"
      className="shrink-0 text-primary"
      disabled={busy}
      // Keep the press from starting a drag or opening the drawer.
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        setBusy(true)
        pickUpStory(story.projectKey, story.number)
          .then((s) => {
            onChange(s)
            toast.success(`You picked up ${s.key}`)
          })
          .catch((err) => toast.error(err instanceof AppError ? err.message : 'Could not pick up the story.'))
          .finally(() => setBusy(false))
      }}
    >
      {busy ? <Spinner /> : <Hand />}
      Pick up
    </Button>
  )
}

/** The card's look — shared by the board and the drag overlay. */
export function StoryCardView({ story, trailing, className }: { story: Story; trailing?: ReactNode; className?: string }) {
  const met = story.acceptanceCriteria.filter((c) => c.met).length
  const total = story.acceptanceCriteria.length
  const allMet = total > 0 && met === total
  return (
    <div className={cn('flex flex-col gap-2.5 rounded-xl border bg-card p-3 text-card-foreground shadow-xs', className)}>
      {/* Wraps the state pill onto its own line in narrow columns instead of squeezing the key and ADO badge. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="font-mono text-[11px] font-medium whitespace-nowrap text-muted-foreground">{story.key}</span>
          <StoryExternalBadge story={story} />
        </span>
        <StoryStatePill story={story} />
      </div>
      <p className="line-clamp-2 text-sm leading-snug font-semibold">{story.title}</p>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <PriorityBadge priority={story.priority} />
        {total > 0 ? (
          <span
            className={cn('flex items-center gap-1.5 text-xs', allMet ? 'text-success' : 'text-muted-foreground')}
            title={`${met} of ${total} acceptance criteria met`}
          >
            <span className={cn('size-1.5 rounded-full', allMet ? 'bg-success' : 'bg-muted-foreground/50')} aria-hidden />
            {met}/{total} criteria
          </span>
        ) : null}
        <DueDateChip story={story} />
        <LabelChips labels={story.labels} />
        <LatestRunTag run={story.latestRun} />
      </div>
      <div className="flex min-h-6 items-center justify-between gap-2 border-t pt-2.5 text-xs text-muted-foreground">
        <span className="truncate" title={`Raised by ${story.createdBy.displayName}`}>
          {story.createdBy.displayName} · {shortAge(story.createdAt)}
        </span>
        {trailing ?? <Assignee story={story} />}
      </div>
    </div>
  )
}

interface Props {
  story: Story
  /** Whether the signed-in user may drag this story anywhere. */
  draggable: boolean
  onOpen: (story: Story) => void
  onChange: (story: Story) => void
}

export default function StoryCard({ story, draggable, onOpen, onChange }: Props) {
  // Cards that can't be dragged still take part in sorting, so others can be dropped around them.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: story.id,
    data: { story },
    disabled: { draggable: !draggable, droppable: false },
  })
  const pickUp = !story.assignee && story.actions.canPickUp
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-label={`${story.key}: ${story.title}`}
      onClick={() => onOpen(story)}
      onKeyDown={(e) => {
        // Enter opens the story; Space (handled by dnd-kit) picks it up to move with the arrow keys.
        if (e.key === 'Enter' && !isDragging) {
          e.preventDefault()
          onOpen(story)
          return
        }
        listeners?.onKeyDown?.(e)
      }}
      className={cn(
        'rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        isDragging && 'opacity-40',
      )}
    >
      <StoryCardView
        story={story}
        className="transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-sm"
        trailing={pickUp ? <PickUpButton story={story} onChange={onChange} /> : undefined}
      />
    </div>
  )
}
