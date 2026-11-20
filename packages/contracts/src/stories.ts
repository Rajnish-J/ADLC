// The story lifecycle: statuses, priorities and who may move a story between statuses. Every story is a
// sub-project that runs through its project's implementation workflow; these are the board columns around it.

import { can, type Actor, type ProjectRole } from './rbac'

export const STORY_STATUSES = ['draft', 'ready', 'in_progress', 'in_review', 'done'] as const
export type StoryStatus = (typeof STORY_STATUSES)[number]

export const STORY_STATUS_LABELS: Record<StoryStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
}

export const STORY_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const
export type StoryPriority = (typeof STORY_PRIORITIES)[number]

export const STORY_PRIORITY_LABELS: Record<StoryPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export interface StoryTransition {
  from: StoryStatus
  to: StoryStatus
  label: string
  /** `lead`: lead, owner or org admin. `assignee`: the story's assignee, or anyone who may act as a lead. */
  by: 'lead' | 'assignee'
}

/**
 * Status moves that need no assignee change. Ready → in progress of an unassigned story happens by picking it up
 * (the developer assigns themselves) or by a lead assigning it; a Ready story that already has its assignee (synced
 * from Azure Boards, say) is started by that assignee. In progress → ready releases the assignee.
 */
export const STORY_TRANSITIONS: readonly StoryTransition[] = [
  { from: 'draft', to: 'ready', label: 'Mark ready', by: 'lead' },
  { from: 'ready', to: 'draft', label: 'Back to draft', by: 'lead' },
  { from: 'ready', to: 'in_progress', label: 'Start', by: 'assignee' },
  { from: 'in_progress', to: 'in_review', label: 'Send for review', by: 'assignee' },
  { from: 'in_progress', to: 'ready', label: 'Release', by: 'assignee' },
  { from: 'in_review', to: 'in_progress', label: 'Back to in progress', by: 'assignee' },
  { from: 'in_review', to: 'done', label: 'Mark done', by: 'lead' },
  { from: 'done', to: 'in_progress', label: 'Reopen', by: 'lead' },
]

export interface StoryState {
  status: StoryStatus
  assigneeId: string | null
}

/** The transitions this actor may make on this story right now. */
export function allowedTransitions(actor: Actor, role: ProjectRole | undefined, story: StoryState): StoryTransition[] {
  const isLead = can(actor, role, 'story.assign')
  return STORY_TRANSITIONS.filter((t) => {
    if (t.from !== story.status) return false
    // Starting a Ready story without picking it up needs it to have an assignee already.
    if (t.from === 'ready' && t.to === 'in_progress' && story.assigneeId === null) return false
    return t.by === 'lead' ? isLead : can(actor, role, 'story.transition', story)
  })
}

/** Whether the actor may pick this story up (assign it to themselves and start it). */
export function canPickUp(actor: Actor, role: ProjectRole | undefined, story: StoryState): boolean {
  return story.status === 'ready' && story.assigneeId === null && can(actor, role, 'story.pickup')
}

/** `PAY-42` — the human key of a story. */
export function storyKey(projectKey: string, number: number): string {
  return `${projectKey}-${number}`
}
