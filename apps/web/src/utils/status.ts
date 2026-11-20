import type { ProjectRole, StoryPriority, StoryStatus } from '@sdlc/contracts'

/** Board-column colour per status (CSS-variable tokens defined in globals.css). */
export const STATUS_DOT: Record<StoryStatus, string> = {
  draft: 'bg-status-draft',
  ready: 'bg-status-ready',
  in_progress: 'bg-status-in-progress',
  in_review: 'bg-status-in-review',
  done: 'bg-status-done',
}

export const STATUS_TEXT: Record<StoryStatus, string> = {
  draft: 'text-status-draft',
  ready: 'text-status-ready',
  in_progress: 'text-status-in-progress',
  in_review: 'text-status-in-review',
  done: 'text-status-done',
}

/** Tinted pill (border + background) per status, for the card and drawer state pills. */
export const STATUS_PILL: Record<StoryStatus, string> = {
  draft: 'border-status-draft/30 bg-status-draft/10',
  ready: 'border-status-ready/30 bg-status-ready/10',
  in_progress: 'border-status-in-progress/30 bg-status-in-progress/10',
  in_review: 'border-status-in-review/30 bg-status-in-review/10',
  done: 'border-status-done/30 bg-status-done/10',
}

/** Small dot per priority, for menus where a full badge is too heavy. */
export const PRIORITY_DOT: Record<StoryPriority, string> = {
  critical: 'bg-destructive',
  high: 'bg-warning',
  medium: 'bg-primary/60',
  low: 'bg-muted-foreground/40',
}

export type BadgeVariant ='default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'warning'

export const PRIORITY_VARIANT: Record<StoryPriority, BadgeVariant> = {
  critical: 'destructive',
  high: 'warning',
  medium: 'secondary',
  low: 'outline',
}

export const PRIORITY_LABEL: Record<StoryPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export const PRIORITY_ORDER: Record<StoryPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 }

export const ROLE_VARIANT: Record<ProjectRole, BadgeVariant> = {
  owner: 'default',
  lead: 'success',
  developer: 'secondary',
  viewer: 'outline',
}
