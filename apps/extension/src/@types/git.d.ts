// Ambient types for VS Code's built-in `vscode.git` extension API.
//
// Trimmed to the subset this extension actually uses. Adapted from the upstream
// `extensions/git/src/api/git.d.ts` in https://github.com/microsoft/vscode (MIT licensed) —
// that file isn't published as an npm package, so consuming extensions vendor a copy.
// Keep member names/shapes in sync with upstream if the vendored surface needs to grow.

import type { Uri, Event } from 'vscode'

export interface UpstreamRef {
  readonly remote: string
  readonly name: string
  readonly commit?: string
}

export interface Ref {
  readonly name?: string
  readonly commit?: string
  readonly remote?: string
}

export interface Branch extends Ref {
  readonly upstream?: UpstreamRef
  readonly ahead?: number
  readonly behind?: number
}

export interface Remote {
  readonly name: string
  readonly fetchUrl?: string
  readonly pushUrl?: string
  readonly isReadOnly: boolean
}

export interface Change {
  readonly uri: Uri
  readonly originalUri: Uri
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined
  readonly remotes: Remote[]
  readonly workingTreeChanges: Change[]
  readonly indexChanges: Change[]
  readonly untrackedChanges?: Change[]
  readonly onDidChange: Event<void>
}

export const enum ForcePushMode {
  Force,
  ForceWithLease,
  ForceWithLeaseIfIncludes,
}

export interface CommitOptions {
  all?: boolean | 'tracked'
}

export interface Repository {
  readonly rootUri: Uri
  readonly state: RepositoryState

  add(paths: string[]): Promise<void>
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>
  checkout(treeish: string): Promise<void>
  getBranch(name: string): Promise<Branch>
  commit(message: string, opts?: CommitOptions): Promise<void>
  push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: ForcePushMode): Promise<void>
  status(): Promise<void>
}

/** The git executable the built-in extension resolved (respects the `git.path` setting). */
export interface Git {
  readonly path: string
}

export interface API {
  readonly git: Git
  readonly repositories: Repository[]
  readonly onDidOpenRepository: Event<Repository>
  readonly onDidCloseRepository: Event<Repository>
  getRepository(uri: Uri): Repository | null
}

export interface GitExtension {
  readonly enabled: boolean
  getAPI(version: 1): API
}
