// Where a story may go next, for the board's drag and drop and the drawer's Column select. It reads the
// story's own `actions` — computed by the API with the rules it enforces — so nothing offered is refused.
// Ready → In progress isn't a transition: it's a pick-up (you become the assignee). Every move goes through the
// board's move endpoint, which also takes the cards a story was dropped between.

import type { Story, StoryStatus, User } from '@sdlc/contracts'
import { moveStoryTo } from '@/service/story.service'

export interface StoryMove {
  to: StoryStatus
  /** The API's wording for the move ("Send for review"), or "Pick up". */
  label: string
  pickUp: boolean
}

/** The cards a story was dropped between (null at either end of the column). */
export interface DropPosition {
  afterId: string | null
  beforeId: string | null
}

const RANK_STEP = 1024

export function storyMoves(story: Story): StoryMove[] {
  const moves: StoryMove[] = story.actions.transitions.map((t) => ({ to: t.to, label: t.label, pickUp: false }))
  if (story.status === 'ready' && story.actions.canPickUp && !moves.some((m) => m.to === 'in_progress')) {
    moves.push({ to: 'in_progress', label: 'Pick up', pickUp: true })
  }
  return moves
}

export function findMove(story: Story, to: StoryStatus): StoryMove | undefined {
  return storyMoves(story).find((m) => m.to === to)
}

/** Reordering within a column needs edit rights on the story (leads: any story; developers: their own). */
export function canReorder(story: Story): boolean {
  return story.actions.canEdit
}

export function canDrag(story: Story): boolean {
  return canReorder(story) || storyMoves(story).length > 0
}

export function performMove(story: Story, to: StoryStatus, position?: DropPosition): Promise<Story> {
  return moveStoryTo(story.projectKey, story.number, { to, afterId: position?.afterId ?? null, beforeId: position?.beforeId ?? null })
}

/** The rank the API will give a story dropped between two cards (same rule as the server). */
export function rankBetween(prev: number | undefined, next: number | undefined, fallback: number): number {
  if (prev === undefined && next === undefined) return fallback
  if (prev === undefined) return (next as number) - RANK_STEP
  if (next === undefined) return prev + RANK_STEP
  return (prev + next) / 2
}

/** What the board shows until the API answers: the new column, place, and the assignee the move implies. */
export function optimisticMove(story: Story, to: StoryStatus, me: User | null, rank: number = story.rank): Story {
  const pickUp = story.status === 'ready' && to === 'in_progress'
  const released = story.status === 'in_progress' && to === 'ready'
  const assignee = pickUp ? (me ?? story.assignee) : released ? null : story.assignee
  return { ...story, status: to, assignee, rank }
}

/** The toast for a move, or null for a reorder within the column (nothing worth announcing). */
export function moveToast(story: Story, to: StoryStatus): string | null {
  if (to === story.status) return null
  const move = findMove(story, to)
  if (move?.pickUp) return `You picked up ${story.key}`
  return `${story.key}: ${(move?.label ?? `moved to ${to}`).toLowerCase()}`
}

/** Board order within a column: the rank people dragged it to, then the story number. */
export function byRank(a: Story, b: Story): number {
  return a.rank - b.rank || a.number - b.number
}
