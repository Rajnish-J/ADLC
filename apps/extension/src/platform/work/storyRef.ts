// Which platform story a branch (or a run) belongs to. Pure — no `vscode` — so it is unit-testable.

/** A story by its human key, e.g. PAY-2 → { projectKey: 'PAY', number: 2 }. */
export interface StoryRef {
  projectKey: string
  number: number
}

const KEY = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/

export function storyFromKey(key: string | undefined | null): StoryRef | undefined {
  const m = KEY.exec((key ?? '').trim().toUpperCase())
  return m ? { projectKey: m[1], number: Number(m[2]) } : undefined
}

export function storyKeyOf(ref: StoryRef): string {
  return `${ref.projectKey}-${ref.number}`
}

/**
 * The story a branch is for, by the platform's naming convention `story/PAY-2-short-title` (the branch the
 * extension offers to create when you pick a story up). Also accepts `story/PAY-2` and `feature/PAY-2-…`-style
 * prefixes, but only when the key directly follows a `/` — `fix-PAY-2` is not matched.
 */
export function storyFromBranch(branch: string | undefined | null): StoryRef | undefined {
  if (!branch) return undefined
  const m = /(?:^|\/)([A-Za-z][A-Za-z0-9]{1,9})-(\d+)(?:-|$)/.exec(branch.replace(/^refs\/heads\//, ''))
  if (!m || !branch.includes('/')) return undefined
  return { projectKey: m[1].toUpperCase(), number: Number(m[2]) }
}

/**
 * Resolve the story for a branch: an explicit link the developer made ("Link this branch to a story") wins over
 * the naming convention.
 */
export function resolveStory(branch: string | undefined, links: Record<string, string>): StoryRef | undefined {
  if (!branch) return undefined
  return storyFromKey(links[branch]) ?? storyFromBranch(branch)
}
