// Thin client over VS Code's built-in `vscode.git` extension API — mirrors adoClient.ts's role
// (low-level integration, no tool-gating or governance concerns here).
//
// We use the built-in Git extension's API rather than shelling out to `git` or adding a new
// dependency: it hands us an already-resolved `Repository` model (no need to hand-roll `.git`
// discovery or multi-root workspace handling) and keeps behavior consistent with what the Source
// Control view shows for the same repo.

import * as vscode from 'vscode'
import type { API, GitExtension, Remote, Repository } from '../../@types/git'

/** Activate (if needed) and return the built-in git extension's API, or undefined if unavailable. */
export async function getGitApi(): Promise<API | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git')
  if (!ext) return undefined
  const gitExtension = ext.isActive ? ext.exports : await ext.activate()
  return gitExtension.enabled ? gitExtension.getAPI(1) : undefined
}

/** The Repository for the current workspace, preferring a repo matching an open workspace folder. */
export async function getRepository(): Promise<Repository | undefined> {
  const api = await getGitApi()
  if (!api || api.repositories.length === 0) return undefined

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const match = api.getRepository(folder.uri)
    if (match) return match
  }
  return api.repositories[0]
}

/**
 * Like getRepository, but waits (up to `timeoutMs`) for the git extension to open the workspace's repository — right
 * after VS Code starts, or when a deep link lands in a cold window, `repositories` is still empty for a few seconds.
 */
export async function waitForRepository(timeoutMs = 10_000): Promise<Repository | undefined> {
  const now = await getRepository()
  if (now) return now
  const api = await getGitApi()
  if (!api || !vscode.workspace.workspaceFolders?.length) return undefined
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, timeoutMs)
    const sub = api.onDidOpenRepository(() => done())
    function done(): void {
      clearTimeout(timer)
      sub.dispose()
      resolve()
    }
  })
  return getRepository()
}

/** The 'origin' remote (or the first remote, if none is named 'origin'), or undefined if none exist. */
export function getOriginRemote(repo: Repository): Remote | undefined {
  return repo.state.remotes.find((r) => r.name === 'origin') ?? repo.state.remotes[0]
}

// The Azure Repos URL parser moved to @sdlc/contracts (the API validates linked repositories with it).
export { parseAzureGitRemote, type AzureGitRemote } from '@sdlc/contracts'
