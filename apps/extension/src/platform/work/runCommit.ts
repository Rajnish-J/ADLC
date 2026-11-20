// After each agent step, the files that step changed are committed to the run's branch — locally only, never
// pushed — so the branch holds the run's work step by step (and the platform's Code page lists its commits).
// Only the step's own files are staged: anything else the user had changed in the working tree stays uncommitted.
// Free of `vscode`, so it is tested against a real repository.

import type { GitCli } from './gitCli'

/** Paths under these folders are the run's session and harness wiring — never committed (they are git-excluded too). */
const NEVER = /^(?:\.sdlc|\.git)\//

export interface StepCommitInput {
  /** `PAY-12`, `PAY-12-T1`, or null for a quick fix. */
  workKey: string | null
  /** The agent that did the step (`Implementer`). */
  agentName?: string | null
  /** What the step reported it did; its first line becomes the subject. */
  summary: string
  /** The step's files (relative to the repository root), from the run's change tracker. */
  paths: string[]
  runId: string
  stepId: string
}

/** The commit message: `PAY-12 Implementer: <first line of the summary>`, with the run and step as trailers. */
export function stepCommitMessage(i: Omit<StepCommitInput, 'paths'>): string {
  const first =
    i.summary
      .split(/\r?\n/)
      .map((l) => l.replace(/^[#>*\s-]+/, '').trim())
      .find(Boolean) ?? 'Step completed'
  const prefix = [i.workKey, i.agentName ? `${i.agentName}:` : null].filter(Boolean).join(' ')
  const subject = `${prefix ? `${prefix} ` : ''}${first}`.slice(0, 100)
  return `${subject}\n\nSDLC-Run: ${i.runId}\nSDLC-Step: ${i.stepId}\n`
}

/**
 * Stage the step's paths (adds, edits and deletions) and commit them. Returns the new commit's sha, or null when
 * there was nothing to commit. Throws when git refuses (a failing pre-commit hook, say) — the caller logs it and
 * the step still completes; its changes stay in the working tree and are picked up by the next step's commit.
 */
export async function commitStep(git: GitCli, input: StepCommitInput): Promise<string | null> {
  const paths = [...new Set(input.paths.filter((p) => p && !NEVER.test(p)))]
  if (paths.length === 0) return null
  // `-A` with pathspecs stages deletions too. A path that exists nowhere (created and removed again within the run)
  // fails the whole `add`, so fall back to adding one path at a time and skipping those.
  if ((await git.tryRun(['add', '-A', '--', ...paths])) === undefined) {
    for (const p of paths) await git.tryRun(['add', '-A', '--', p])
  }
  // Commit exactly what got staged (a path that exists nowhere would fail the commit). `--no-renames` lists both
  // sides of a rename, so the old path's removal is committed too.
  const staged = ((await git.tryRun(['diff', '--cached', '--name-only', '--no-renames', '--', ...paths])) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (staged.length === 0) return null
  await git.run(['commit', '-m', stepCommitMessage(input), '--', ...staged])
  return (await git.tryRun(['rev-parse', 'HEAD']))?.trim() || null
}
