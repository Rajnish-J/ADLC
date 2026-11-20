// Pure helpers for showing and working on platform stories in VS Code (no `vscode`, unit-testable).

import { STORY_STATUSES, STORY_STATUS_LABELS, type Story, type StoryStatus } from '@sdlc/contracts'

/** Re-exported from contracts: the API and the web match VS Code windows to a project's repo the same way. */
export { sameRepository } from '@sdlc/contracts'

/** `story/PAY-2-refund-api-endpoint` — the branch a developer works on for a story. */
export function storyBranchName(story: Pick<Story, 'key' | 'title'>): string {
  const slug = story.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return `story/${story.key}${slug ? `-${slug}` : ''}`
}

/** The branch a quick fix (a run from a prompt, no story) works on: `quick/<prompt slug>-<run id prefix>`. */
export function quickBranchName(prompt: string, runId: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  const id = runId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()
  return `quick/${slug ? `${slug}-` : ''}${id}`
}

/**
 * The task a local workflow run is seeded with: the story, its description and acceptance criteria — so every
 * agent in the run works against the same definition of done.
 */
export function storyTaskPrompt(story: Pick<Story, 'key' | 'title' | 'description' | 'acceptanceCriteria'>): string {
  const lines = [`${story.key}: ${story.title}`]
  if (story.description.trim()) lines.push('', story.description.trim())
  if (story.acceptanceCriteria.length > 0) {
    lines.push('', 'Acceptance criteria:')
    for (const c of story.acceptanceCriteria) lines.push(`- [${c.met ? 'x' : ' '}] ${c.text}`)
  }
  return lines.join('\n')
}

/**
 * Tree-item context value: `platformStory` plus flags the package.json menus match on — `:pickup` when the user
 * may pick it up, `:move` when they may move it, `:mine` when it's assigned to them, `:edit` / `:assign` when they
 * may edit / assign it, `:memory` when they may add to its memory. All come from the server's `actions`.
 */
export function storyContextValue(story: Pick<Story, 'actions' | 'assignee'>, currentUserId: string | undefined): string {
  let value = 'platformStory'
  if (story.actions.canPickUp) value += ':pickup'
  if (story.actions.transitions.length > 0) value += ':move'
  if (currentUserId && story.assignee?.id === currentUserId) value += ':mine'
  if (story.actions.canEdit) value += ':edit'
  if (story.actions.canAssign) value += ':assign'
  if (story.actions.canAddMemory) value += ':memory'
  return value
}

/** Labels and due date as one short line ("#api #infra · due 2026-11-30"), or '' when there are none. */
export function storyTagLine(story: Pick<Story, 'labels' | 'dueDate'>): string {
  const tags = story.labels.map((l) => `#${l}`).join(' ')
  return [tags, story.dueDate ? `due ${story.dueDate}` : ''].filter(Boolean).join(' · ')
}

/** Is the story past its due date (and not done)? `today` is `YYYY-MM-DD`. */
export function isOverdue(story: Pick<Story, 'dueDate' | 'status'>, today: string): boolean {
  return Boolean(story.dueDate && story.status !== 'done' && story.dueDate < today)
}

/** The web board's order: column, then the board rank (drag order), then number. */
export function compareStories(a: Pick<Story, 'status' | 'rank' | 'number'>, b: Pick<Story, 'status' | 'rank' | 'number'>): number {
  return STORY_STATUSES.indexOf(a.status) - STORY_STATUSES.indexOf(b.status) || a.rank - b.rank || a.number - b.number
}

export function statusLabel(status: StoryStatus): string {
  return STORY_STATUS_LABELS[status]
}
