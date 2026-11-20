// The working tree against a commit: tracked changes since it (committed and uncommitted) plus untracked files,
// with +/− counts and the unified diff. Shared by the code-activity tracker (against HEAD) and the run change
// tracker (against the commit a run started from). Read-only towards git, and free of `vscode` so it is tested
// against a real temporary repository.

import { readFile, stat } from 'fs/promises'
import * as path from 'path'
import type { ChangedFile } from '@sdlc/contracts'
import type { GitCli } from './gitCli'
import { looksBinary, mergeFileStats, parseNameStatusZ, parseNumstatZ, syntheticAddPatch } from './gitParse'

export const MAX_UNTRACKED_FILES = 200
export const MAX_UNTRACKED_BYTES = 64 * 1024

export interface DiffOptions {
  /** Include the diff text (sdlcGovernance.platform.shareDiffs). */
  shareDiffs: boolean
  /** Paths whose content is never shared (sdlcGovernance.platform.diffExclude). */
  exclude: (path: string) => boolean
}

export interface WorkingDiff {
  files: ChangedFile[]
  /** The raw unified diff (every file, untracked ones as synthetic add patches); run it through safePatch to share. */
  patch: string
  /**
   * The diff (or the file list) is incomplete: the patch was too large for git's output buffer — lockfile or
   * generated-file churn — or there were more untracked files than are listed.
   */
  incomplete: boolean
}

/**
 * Changes in the working tree against `base` (a commit sha or `HEAD`). `base` null means the repository has no
 * commits yet, so only untracked files count.
 */
export async function diffAgainst(git: GitCli, root: string, base: string | null, opts: DiffOptions): Promise<WorkingDiff> {
  const names = base ? parseNameStatusZ(await git.run(['diff', '--name-status', '-z', '-M', base])) : []
  const stats = base ? parseNumstatZ(await git.run(['diff', '--numstat', '-z', '-M', base])) : new Map()
  const files = mergeFileStats(names, stats, opts.exclude)
  let patch = ''
  let incomplete = false
  if (opts.shareDiffs && base && names.length) {
    try {
      patch = await git.run(['diff', '--no-ext-diff', '-M', base])
    } catch {
      // Too large for the output buffer: still report the files and their counts, just without the diff.
      incomplete = true
    }
  }

  const allUntracked = (await git.run(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  if (allUntracked.length > MAX_UNTRACKED_FILES) incomplete = true
  const untracked = allUntracked.slice(0, MAX_UNTRACKED_FILES)
  for (const file of untracked) {
    const excluded = opts.exclude(file)
    let additions = 0
    let binary = false
    if (!excluded) {
      try {
        const full = path.join(root, ...file.split('/'))
        if ((await stat(full)).size <= MAX_UNTRACKED_BYTES) {
          const bytes = await readFile(full)
          binary = looksBinary(bytes)
          if (!binary) {
            const added = syntheticAddPatch(file, new TextDecoder().decode(bytes))
            additions = added.additions
            if (opts.shareDiffs) patch += `${patch && !patch.endsWith('\n') ? '\n' : ''}${added.patch}\n`
          }
        }
      } catch {
        /* vanished or unreadable — list it without counts */
      }
    }
    files.push({ path: file, status: 'untracked', additions, deletions: 0, binary, excluded })
  }
  return { files, patch, incomplete }
}

/**
 * A fingerprint per changed file — status, line counts and the content's blob id — so two snapshots tell which
 * files changed in between (also when the line counts happen to stay the same).
 */
export async function fingerprintFiles(git: GitCli, files: ChangedFile[]): Promise<Map<string, string>> {
  const present = files.filter((f) => f.status !== 'deleted').map((f) => f.path)
  const blobs = new Map<string, string>()
  for (let i = 0; i < present.length; i += 100) {
    const chunk = present.slice(i, i + 100)
    const out = await git.tryRun(['hash-object', '--', ...chunk])
    const ids = out?.split('\n').map((s) => s.trim()).filter(Boolean) ?? []
    if (ids.length === chunk.length) {
      chunk.forEach((p, n) => blobs.set(p, ids[n]))
      continue
    }
    // One path git can't hash (a submodule folder, a file deleted meanwhile) fails the whole batch: hash one by one.
    for (const p of chunk) {
      const id = (await git.tryRun(['hash-object', '--', p]))?.trim()
      if (id) blobs.set(p, id)
    }
  }
  return new Map(files.map((f) => [f.path, `${f.status}:${f.additions}:${f.deletions}:${blobs.get(f.path) ?? ''}`]))
}
