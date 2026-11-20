// What the repository module needs at run time: database, events, settings, the token cipher and whether git is
// available on this host. Built once in app.ts.

import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { FastifyBaseLogger } from 'fastify'
import type { Config } from '../config'
import type { Db } from '../db/client'
import type { projectRepositories } from '../db/schema'
import type { EventBus } from '../events'
import { HttpError } from '../http'
import { CredentialCipher } from './credentials'
import { gitVersion } from './git'

export type RepoRow = typeof projectRepositories.$inferSelect

export interface RepoRuntime {
  db: Db
  bus: EventBus
  log: FastifyBaseLogger
  cipher: CredentialCipher
  workDir: string
  maxFileBytes: number
  maxFiles: number
  gitTimeoutMs: number
  concurrency: number
  /** file:// remotes are accepted only outside production (for tests). */
  allowLocal: boolean
  git: { ok: boolean; version: string | null; error: string | null }
}

/** git 2.31+ is needed for GIT_CONFIG_COUNT (how the token reaches git without touching argv or disk). */
const MIN_GIT = { major: 2, minor: 31 }

export function createRepoRuntime(db: Db, bus: EventBus, log: FastifyBaseLogger, config: Config): RepoRuntime {
  if (!config.REPO_CREDENTIAL_KEY) log.warn('REPO_CREDENTIAL_KEY is not set: repository tokens use the development key. Never do this in production.')
  return {
    db,
    bus,
    log,
    cipher: new CredentialCipher(config.REPO_CREDENTIAL_KEY),
    workDir: config.REPO_WORK_DIR || join(tmpdir(), 'sdlc-repos'),
    maxFileBytes: config.REPO_MAX_FILE_BYTES,
    maxFiles: config.REPO_MAX_FILES,
    gitTimeoutMs: config.REPO_GIT_TIMEOUT_MS,
    concurrency: config.REPO_JOB_CONCURRENCY,
    allowLocal: config.NODE_ENV !== 'production',
    git: { ok: false, version: null, error: 'Checking for git on the API server…' },
  }
}

/** Find git and check its version (run once at startup, before the server listens). */
export async function detectGit(rt: RepoRuntime): Promise<void> {
  try {
    const v = await gitVersion()
    const ok = v.major > MIN_GIT.major || (v.major === MIN_GIT.major && v.minor >= MIN_GIT.minor)
    rt.git = ok
      ? { ok, version: v.text, error: null }
      : { ok, version: v.text, error: `git ${MIN_GIT.major}.${MIN_GIT.minor} or later is required on the API server (found ${v.text}).` }
  } catch {
    rt.git = { ok: false, version: null, error: 'git is not installed on the API server, so repositories cannot be cloned.' }
  }
  if (rt.git.ok) rt.log.info(`Repositories: using ${rt.git.version}`)
  else rt.log.warn(rt.git.error ?? 'git unavailable')
}

/** 503 when git can't run here. */
export function requireGit(rt: RepoRuntime): void {
  if (!rt.git.ok) throw new HttpError(503, 'git_unavailable', rt.git.error ?? 'git is not available on the API server.')
}

/** Run `fn` in a fresh, private temp folder that is always removed afterwards. */
export async function withTempDir<T>(rt: RepoRuntime, prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  await mkdir(rt.workDir, { recursive: true })
  const dir = await mkdtemp(join(rt.workDir, `${prefix}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((err) =>
      rt.log.warn({ err, dir }, 'Could not remove a repository temp folder'),
    )
  }
}
