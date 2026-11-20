// Git commands run with the same git executable the built-in Git extension uses. The code-activity and run-change
// trackers only inspect (diff, log, show, rev-parse, merge-base, ls-files); runCommit.ts is the one writer — it
// commits each run step's own files to the run's branch, locally.

import { execFile } from 'child_process'

export class GitCli {
  constructor(
    private readonly gitPath: string,
    private readonly cwd: string,
  ) {}

  run(args: string[], maxBuffer = 32 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.gitPath,
        ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
        { cwd: this.cwd, maxBuffer, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      )
    })
  }

  /** Like run(), but undefined instead of throwing (for probes such as "does this ref exist?"). */
  async tryRun(args: string[]): Promise<string | undefined> {
    try {
      return await this.run(args)
    } catch {
      return undefined
    }
  }

  /**
   * Where the story branch started: the merge-base with the repo's main line — origin/HEAD, then the configured
   * target branch, then main/master. Undefined when none of them exists (then the caller limits by count).
   */
  async baseCommit(targetBranch: string | undefined): Promise<string | undefined> {
    const candidates = ['origin/HEAD', ...(targetBranch ? [`origin/${targetBranch}`, targetBranch] : []), 'origin/main', 'main', 'origin/master', 'master']
    for (const ref of [...new Set(candidates)]) {
      const exists = await this.tryRun(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      if (!exists?.trim()) continue
      const base = await this.tryRun(['merge-base', 'HEAD', ref])
      if (base?.trim()) return base.trim()
    }
    return undefined
  }
}
