// Which tracked files the platform keeps. A clone only contains tracked files, but a repository can still track
// files its .gitignore excludes (committed before the rule, or force-added). Those are dropped too, with git's own
// semantics: every .gitignore applies to paths below its folder, deeper files override shallower ones, and nothing
// inside an ignored folder can be re-included. On top of that, some paths are never kept (.git, node_modules), and
// files that look like secrets are listed but their contents are never stored.

import ignore, { type Ignore } from 'ignore'

export type Classification = 'keep' | 'ignored' | 'secret'

/** Folders never kept, wherever they appear. */
const ALWAYS_IGNORED_DIRS = new Set(['.git', 'node_modules'])

/** File names whose contents are never stored or shown (same spirit as the extension's diffExclude defaults). */
const SECRET_NAME_PATTERNS: RegExp[] = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$|defaults?$|dist$).+$/i,
  /\.(pem|key|pfx|p12|jks|keystore|publishsettings|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^secrets?\.(json|ya?ml|toml|ini|env|txt)$/i,
  /^\.(netrc|pgpass|npmrc|pypirc)$/i,
  /^credentials(\.json)?$/i,
]

export function looksSecret(path: string): boolean {
  const name = path.split('/').pop() ?? path
  return SECRET_NAME_PATTERNS.some((re) => re.test(name))
}

interface Level {
  /** Folder of the .gitignore, '' for the root, without trailing slash. */
  dir: string
  rules: Ignore
}

export class IgnoreRules {
  private readonly levels: Level[]

  /** @param gitignores folder ('' = root) → contents of the .gitignore in it. */
  constructor(gitignores: Map<string, string>) {
    this.levels = [...gitignores.entries()]
      .map(([dir, text]) => ({ dir, rules: ignore({ allowRelativePaths: true }).add(text) }))
      // Shallow to deep, so deeper .gitignore files are applied last and win.
      .sort((a, b) => (a.dir === '' ? -1 : b.dir === '' ? 1 : a.dir.split('/').length - b.dir.split('/').length || a.dir.localeCompare(b.dir)))
  }

  /** Whether `path` (a file, or a folder when `isDir`) is ignored by the .gitignore rules alone. */
  private matches(path: string, isDir: boolean): boolean {
    let ignored = false
    for (const level of this.levels) {
      const prefix = level.dir === '' ? '' : `${level.dir}/`
      if (prefix && !path.startsWith(prefix)) continue
      const rel = path.slice(prefix.length) + (isDir ? '/' : '')
      if (!rel || rel === '/') continue
      const r = level.rules.test(rel)
      if (r.ignored) ignored = true
      else if (r.unignored) ignored = false
    }
    return ignored
  }

  /** Whether the file at `path` is excluded — by .gitignore (including any ignored parent folder) or the defaults. */
  isIgnored(path: string): boolean {
    const parts = path.split('/')
    for (let i = 0; i < parts.length - 1; i++) {
      if (ALWAYS_IGNORED_DIRS.has(parts[i])) return true
    }
    // Git never descends into an ignored folder, so a file below one can't be re-included.
    for (let i = 1; i < parts.length; i++) {
      if (this.matches(parts.slice(0, i).join('/'), true)) return true
    }
    return this.matches(path, false)
  }

  classify(path: string): Classification {
    if (this.isIgnored(path)) return 'ignored'
    return looksSecret(path) ? 'secret' : 'keep'
  }
}

/** The folder a .gitignore at `path` governs ('' for the root one), or null if `path` isn't a .gitignore. */
export function gitignoreDir(path: string): string | null {
  if (path === '.gitignore') return ''
  return path.endsWith('/.gitignore') ? path.slice(0, -'/.gitignore'.length) : null
}
