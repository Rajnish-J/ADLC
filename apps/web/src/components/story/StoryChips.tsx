// Small read-only chips for a story's labels and due date — on the board cards and in the drawer.

import { CalendarClock } from 'lucide-react'
import type { Story } from '@sdlc/contracts'
import { cn } from '@/lib/utils'
import { dueState, formatDueDate, type DueState } from '@/utils/format'

const DUE_TONE: Record<DueState, string> = {
  overdue: 'border-destructive/30 bg-destructive/10 text-destructive',
  today: 'border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning',
  soon: 'border-warning/40 bg-warning/10 text-warning-foreground dark:text-warning',
  later: 'border-border text-muted-foreground',
}

const DUE_HINT: Record<DueState, string> = { overdue: 'Overdue', today: 'Due today', soon: 'Due soon', later: 'Due' }

export function DueDateChip({ story, className }: { story: Pick<Story, 'dueDate' | 'status'>; className?: string }) {
  if (!story.dueDate) return null
  const state = dueState(story.dueDate, story.status === 'done')
  return (
    <span
      className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium', DUE_TONE[state], className)}
      title={`${DUE_HINT[state]} ${formatDueDate(story.dueDate)}`}
    >
      <CalendarClock className="size-3" aria-hidden />
      {formatDueDate(story.dueDate)}
    </span>
  )
}

export function LabelChip({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 max-w-36 shrink-0 items-center rounded-md border bg-background px-1.5 text-[11px] text-muted-foreground', className)}>
      <span className="truncate">{label}</span>
    </span>
  )
}

/** The first `max` labels, then "+n" for the rest. */
export function LabelChips({ labels, max = 2 }: { labels: string[]; max?: number }) {
  if (labels.length === 0) return null
  const rest = labels.length - max
  return (
    <>
      {labels.slice(0, max).map((l) => (
        <LabelChip key={l} label={l} />
      ))}
      {rest > 0 ? (
        <span className="text-[11px] text-muted-foreground" title={labels.slice(max).join(', ')}>
          +{rest}
        </span>
      ) : null}
    </>
  )
}
