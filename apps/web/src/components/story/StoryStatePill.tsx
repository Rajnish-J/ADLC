import { STORY_STATUS_LABELS, type Story } from '@sdlc/contracts'
import { cn } from '@/lib/utils'
import { STATUS_DOT, STATUS_PILL } from '@/utils/status'

const PILL = 'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium text-foreground/80'

/** The story's state at a glance: "Blocked" when it is, otherwise its column. */
export default function StoryStatePill({ story, className }: { story: Story; className?: string }) {
  if (story.isBlocked) {
    return (
      <span className={cn(PILL, 'border-destructive/30 bg-destructive/10 text-destructive', className)} title={story.blockedReason ?? undefined}>
        <span className="size-1.5 rounded-full bg-destructive" aria-hidden />
        Blocked
      </span>
    )
  }
  return (
    <span className={cn(PILL, STATUS_PILL[story.status], className)}>
      <span className={cn('size-1.5 rounded-full', STATUS_DOT[story.status])} aria-hidden />
      {STORY_STATUS_LABELS[story.status]}
    </span>
  )
}
