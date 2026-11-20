// Which live events should refresh which data. Code-activity events (a developer's working state is re-reported
// every few seconds while they edit) and memory events only matter to the screens that show them — never refetch
// the board or the project for them.

import type { PlatformEvent } from '@sdlc/contracts'

/** Stories or the project itself changed (board columns, counts, membership). */
export function storiesOrProjectChanged(key: string | undefined) {
  return (e: PlatformEvent): boolean => key !== undefined && (e.type === 'story.changed' || e.type === 'project.changed') && e.projectKey === key
}

/** The board: stories or the project changed, or a story's run started or ended (its card shows the workflow). */
export function boardChanged(key: string | undefined) {
  const stories = storiesOrProjectChanged(key)
  return (e: PlatformEvent): boolean =>
    stories(e) || (key !== undefined && e.type === 'work.changed' && e.kind === 'run' && e.projectKey === key && e.storyNumber != null)
}

/** Anything that writes to the project's audit log — i.e. everything except live working-state snapshots. */
export function auditedChange(key: string) {
  return (e: PlatformEvent): boolean =>
    'projectKey' in e && e.projectKey === key && !(e.type === 'work.changed' && e.kind === 'workspace')
}

/** A story's memory changed, or the project's (shown alongside it). */
export function storyMemoryChanged(key: string, number: number) {
  return (e: PlatformEvent): boolean => e.type === 'memory.changed' && e.projectKey === key && (e.storyNumber === number || e.storyNumber === null)
}

export function projectMemoryChanged(key: string) {
  return (e: PlatformEvent): boolean => e.type === 'memory.changed' && e.projectKey === key
}

/** The project profile was generated, proposed after runs, accepted, rejected or edited. */
export function profileChanged(key: string) {
  return (e: PlatformEvent): boolean => e.type === 'profile.changed' && e.projectKey === key
}

/** Code activity on one story (working state, commits, runs). */
export function storyWorkChanged(key: string, number: number) {
  return (e: PlatformEvent): boolean => e.type === 'work.changed' && e.projectKey === key && e.storyNumber === number
}

/** A run was reported anywhere in the project (any story, any developer). */
export function projectRunsChanged(key: string) {
  return (e: PlatformEvent): boolean => e.type === 'work.changed' && e.projectKey === key && e.kind === 'run'
}

/** The project's agents or workflows changed (enable/disable, step mapping). */
export function catalogChanged(key: string) {
  return (e: PlatformEvent): boolean => e.type === 'project.changed' && e.projectKey === key
}

/**
 * The linked repository changed: a sync started or finished, a branch was (re)indexed, a commit landed, or the
 * repository was linked / changed / disconnected. With `branch`, only changes that may touch that branch.
 */
export function repoChanged(key: string, branch?: string) {
  return (e: PlatformEvent): boolean => {
    if (e.type === 'project.changed') return e.projectKey === key && e.action === 'repository'
    if (e.type !== 'repo.changed' || e.projectKey !== key) return false
    return branch === undefined || e.branch === null || e.branch === branch
  }
}

/** Your own preferences or connected VS Code windows changed (events sent only to you). */
export function mySettingsChanged(e: PlatformEvent): boolean {
  return e.type === 'preferences.changed' || e.type === 'client.changed'
}
