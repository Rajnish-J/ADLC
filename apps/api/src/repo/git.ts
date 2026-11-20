// The only place the API runs git. Every call goes through spawn('git', args) — no shell — with:
//   • the access token passed ONLY through GIT_CONFIG_COUNT/KEY/VALUE environment variables (an http.extraHeader),
//     never in argv, the URL or a config file;
//   • credential helpers, terminal prompts and the Git Credential Manager disabled, so nothing can pop up or hang;
//   • only https (and file, in development) transports allowed;
//   • a timeout, and the token redacted from every error message.

import { spawn } from 'child_process'
import type { RepoProvider } from '@sdlc/contracts'

export interface GitAuth {
  provider: RepoProvider
  /** Personal access token; null for an anonymous (public) remote. */
  token: string | null
}

export type GitErrorKind = 'auth' | 'not_found' | 'network' | 'timeout' | 'rejected' | 'protected' | 'forbidden' | 'missing_git' | 'other'

export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    message: string,
    /** Redacted stderr, for logs. */
    readonly detail: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitOptions {
  cwd?: string
  auth?: GitAuth | null
  timeoutMs?: number
  input?: string | Buffer
  env?: Record<string, string>
  /** Allow file:// remotes (development only). */
  allowFileProtocol?: boolean
}

const BASE_CONFIG = [
  '-c', 'credential.helper=',
  '-c', 'core.quotepath=off',
  '-c', 'core.longpaths=true',
  '-c', 'core.autocrlf=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'advice.detachedHead=false',
  '-c', 'init.defaultBranch=main',
]

/** Basic auth header for a PAT: GitHub takes any user name with the token; Azure Repos an empty one. */
function authHeader(auth: GitAuth): string {
  const user = auth.provider === 'github' ? 'x-access-token' : ''
  return `Authorization: Basic ${Buffer.from(`${user}:${auth.token}`).toString('base64')}`
}

function gitEnv(opts: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_ALLOW_PROTOCOL: opts.allowFileProtocol ? 'https:file' : 'https',
    LC_ALL: 'C',
    LANG: 'C',
    ...opts.env,
  }
  // Never inherit a caller's index/dir/work-tree overrides.
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  if (!opts.env?.GIT_INDEX_FILE) delete env.GIT_INDEX_FILE
  if (opts.auth?.token) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    env.GIT_CONFIG_VALUE_0 = authHeader(opts.auth)
  } else {
    delete env.GIT_CONFIG_COUNT
  }
  return env
}

/** Remove the token (raw and base64-encoded) and any Authorization header from text. */
export function redact(text: string, auth?: GitAuth | null): string {
  let out = text.replace(/Authorization:\s*\S+\s+\S+/gi, 'Authorization: ***')
  if (auth?.token) {
    out = out.split(auth.token).join('***')
    const b64 = authHeader(auth).split(' ').pop()
    if (b64) out = out.split(b64).join('***')
  }
  // Credentials embedded in URLs.
  return out.replace(/(https?:\/\/)[^@/\s]+@/gi, '$1')
}

function classify(stderr: string, args: string[]): GitError {
  const s = stderr
  const op = args.find((a) => !a.startsWith('-') && a !== 'c') ?? 'git'
  if (/GH006|protected branch|TF402455|branch policies|pre-receive hook declined/i.test(s)) {
    return new GitError('protected', 'The branch is protected on the remote and does not accept direct pushes. Commit to a new branch instead.', s)
  }
  if (/\[rejected\]|non-fast-forward|fetch first|stale info|\(stale\)/i.test(s)) {
    return new GitError('rejected', 'The branch moved on the remote while committing.', s)
  }
  if (/Write access to repository not granted|TF401027|permission to .* denied|403/i.test(s) && op === 'push') {
    return new GitError('forbidden', 'The token can read the repository but not push to it. Give it write access (Azure: Code Read & Write; GitHub: Contents read and write).', s)
  }
  if (/Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Invalid username or (password|token)|HTTP Basic: Access denied|\b401\b|TF401019/i.test(s)) {
    return new GitError('auth', 'The repository refused access. Check the Git connection for it in Settings.', s)
  }
  if (/Repository not found|not found|does not appear to be a git repository|\b404\b|does not exist/i.test(s)) {
    return new GitError('not_found', 'Repository not found or not accessible — check the URL.', s)
  }
  if (/\b403\b/i.test(s)) {
    return new GitError('auth', 'The repository refused access. Check the Git connection for it in Settings.', s)
  }
  if (/Could not resolve host|Failed to connect|Connection (timed out|refused|reset)|unable to access|SSL|TLS|Operation timed out/i.test(s)) {
    return new GitError('network', 'Could not reach the repository host. Check the URL and the server’s network access.', s)
  }
  const firstLine = s.split(/\r?\n/).find((l) => /^(fatal|error):/i.test(l.trim())) ?? s.split(/\r?\n/)[0] ?? ''
  return new GitError('other', firstLine.replace(/^(fatal|error):\s*/i, '').trim() || `git ${op} failed.`, s)
}

/** Run git and collect stdout as bytes (binary-safe). Rejects with a classified, redacted GitError. */
export function runGit(args: string[], opts: GitOptions = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('git', [...BASE_CONFIG, ...args], {
        cwd: opts.cwd,
        env: gitEnv(opts),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(new GitError('missing_git', 'git is not installed on the API server.', String(err)))
      return
    }
    const out: Buffer[] = []
    const errChunks: Buffer[] = []
    let timedOut = false
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, opts.timeoutMs)
      : null
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => errChunks.push(d))
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer)
      if (err.code === 'ENOENT') reject(new GitError('missing_git', 'git is not installed on the API server.', err.message))
      else reject(new GitError('other', `git failed to start: ${err.message}`, err.message))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const stderr = redact(Buffer.concat(errChunks).toString('utf8'), opts.auth)
      if (timedOut) return reject(new GitError('timeout', 'The git operation timed out.', stderr))
      if (code !== 0) {
        const e = classify(stderr, args)
        e.message = redact(e.message, opts.auth)
        return reject(e)
      }
      resolve({ stdout: Buffer.concat(out), stderr })
    })
    child.stdin.on('error', () => {
      /* the process may exit before reading all input; the close handler reports it */
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

export async function gitText(args: string[], opts: GitOptions = {}): Promise<string> {
  return (await runGit(args, opts)).stdout.toString('utf8')
}

/** `git --version` → [major, minor]; throws GitError('missing_git') when git can't run. */
export async function gitVersion(): Promise<{ text: string; major: number; minor: number }> {
  const text = (await gitText(['--version'], { timeoutMs: 15_000 })).trim()
  const m = text.match(/(\d+)\.(\d+)/)
  return { text, major: m ? Number(m[1]) : 0, minor: m ? Number(m[2]) : 0 }
}

export interface RemoteRefs {
  /** The remote's default branch (its HEAD symref); null if it has none. */
  head: string | null
  /** Branch name → tip commit. */
  branches: Map<string, string>
}

/** `git ls-remote --symref <url> HEAD refs/heads/*` — what is on the remote, without fetching anything. */
export async function lsRemote(url: string, opts: GitOptions): Promise<RemoteRefs> {
  const text = await gitText(['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*'], opts)
  let head: string | null = null
  const branches = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const sym = line.match(/^ref:\s+refs\/heads\/(.+)\tHEAD$/)
    if (sym) {
      head = sym[1]
      continue
    }
    const ref = line.match(/^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/)
    if (ref) branches.set(ref[2], ref[1])
  }
  return { head, branches }
}

export interface TreeEntryRaw {
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  /** Bytes; 0 for submodules. */
  size: number
  path: string
}

/** Parse `git ls-tree -r -l -z` output. */
export function parseLsTree(buf: Buffer): TreeEntryRaw[] {
  const out: TreeEntryRaw[] = []
  for (const record of buf.toString('utf8').split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, sha, size] = record.slice(0, tab).trim().split(/\s+/)
    out.push({
      mode,
      type: type as TreeEntryRaw['type'],
      sha,
      size: size && size !== '-' ? Number(size) : 0,
      path: record.slice(tab + 1),
    })
  }
  return out
}

/**
 * Parse `git cat-file --batch` output: for each object `<sha> <type> <size>\n<content>\n`, or `<sha> missing\n`.
 * Exported for tests.
 */
export function parseCatFileBatch(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let pos = 0
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos)
    if (nl < 0) break
    const header = buf.subarray(pos, nl).toString('utf8')
    pos = nl + 1
    const parts = header.split(' ')
    if (parts[1] === 'missing' || parts.length < 3) continue
    const size = Number(parts[2])
    out.set(parts[0], buf.subarray(pos, pos + size))
    pos += size + 1 // content + trailing LF
  }
  return out
}

/** Read objects by sha from a local repository (no network). Callers batch so each call stays small. */
export async function catFileBatch(cwd: string, shas: string[]): Promise<Map<string, Buffer>> {
  if (shas.length === 0) return new Map()
  const { stdout } = await runGit(['cat-file', '--batch'], { cwd, input: shas.join('\n') + '\n', timeoutMs: 5 * 60_000 })
  return parseCatFileBatch(stdout)
}
