import { CircleAlert } from 'lucide-react'
import { STORY_STATUS_LABELS, type StoryPriority, type StoryStatus } from '@sdlc/contracts'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { PRIORITY_LABEL, PRIORITY_VARIANT, STATUS_DOT } from '@/utils/status'

export function StatusBadge({ status, className }: { status: StoryStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-medium', className)}>
      <span className={cn('size-1.5 rounded-full', STATUS_DOT[status])} aria-hidden />
      {STORY_STATUS_LABELS[status]}
    </Badge>
  )
}

export function PriorityBadge({ priority, className }: { priority: StoryPriority; className?: string }) {
  return (
    <Badge variant={PRIORITY_VARIANT[priority]} className={className}>
      {PRIORITY_LABEL[priority]}
    </Badge>
  )
}

export function BlockedBadge({ reason }: { reason?: string | null }) {
  return (
    <Badge variant="destructive" title={reason ?? undefined}>
      <CircleAlert />
      Blocked
    </Badge>
  )
}
