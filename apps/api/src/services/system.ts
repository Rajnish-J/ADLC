// Settings → System (org admins): the server's health for the platform's moving parts. Never returns secrets —
// only whether the token encryption key is set, never its value; no connection strings.

import { readFileSync } from 'fs'
import { join } from 'path'
import { and, count, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { can, type SystemStatus } from '@sdlc/contracts'
import { actorOf } from '../access'
import type { AuthUser } from '../auth'
import type { Config } from '../config'
import { gitConnections, projectRepositories, projects, users } from '../db/schema'
import { forbidden } from '../http'
import { orchestrator } from '../orchestrator/client'
import type { RepoManager } from '../repo/jobs'
import type { ServiceDeps } from './context'

const STARTED_AT = new Date().toISOString()

function apiVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
const API_VERSION = apiVersion()

async function databaseStatus(deps: ServiceDeps): Promise<SystemStatus['database']> {
  try {
    const t0 = performance.now()
    await deps.db.execute(sql`select 1`)
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10
    let migrationsApplied: number | null = null
    try {
      const res = await deps.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
      const row = res.rows[0] as { n?: number } | undefined
      migrationsApplied = Number(row?.n ?? 0)
    } catch {
      migrationsApplied = null
    }
    return { ok: true, latencyMs, migrationsApplied, error: null }
  } catch (err) {
    return { ok: false, latencyMs: null, migrationsApplied: null, error: err instanceof Error ? err.message.split('\n')[0] : 'Unreachable' }
  }
}

export async function systemStatus(deps: ServiceDeps, repos: RepoManager | undefined, config: Config, user: AuthUser): Promise<SystemStatus> {
  if (!can(actorOf(user), undefined, 'org.manage')) throw forbidden('Only an org admin can see the system status.')
  const { db } = deps
  const orgProjects = eq(projects.orgId, user.orgId)
  const [database, [active], [archived], [repoCount], [connCount], [people], orch] = await Promise.all([
    databaseStatus(deps),
    db.select({ n: count() }).from(projects).where(and(orgProjects, isNull(projects.archivedAt))),
    db.select({ n: count() }).from(projects).where(and(orgProjects, isNotNull(projects.archivedAt))),
    db
      .select({ n: count() })
      .from(projectRepositories)
      .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
      .where(and(orgProjects, isNull(projects.archivedAt))),
    db.select({ n: count() }).from(gitConnections).where(eq(gitConnections.orgId, user.orgId)),
    db.select({ n: count() }).from(users).where(eq(users.orgId, user.orgId)),
    orchestrator().health(),
  ])
  const jobs = repos?.stats() ?? { running: 0, queued: 0 }
  return {
    api: { version: API_VERSION, nodeVersion: process.version, environment: config.NODE_ENV, authMode: config.AUTH_MODE, startedAt: STARTED_AT },
    database,
    orchestrator: { ok: orch.ok, url: config.ORCHESTRATOR_URL, detail: orch.detail },
    git: repos
      ? { ok: repos.rt.git.ok, version: repos.rt.git.version, error: repos.rt.git.error }
      : { ok: false, version: null, error: 'Repositories are not enabled on this server.' },
    repositories: {
      credentialKeyConfigured: Boolean(config.REPO_CREDENTIAL_KEY),
      maxFileBytes: config.REPO_MAX_FILE_BYTES,
      maxFiles: config.REPO_MAX_FILES,
      jobConcurrency: config.REPO_JOB_CONCURRENCY,
      gitTimeoutMs: config.REPO_GIT_TIMEOUT_MS,
      jobsRunning: jobs.running,
      jobsQueued: jobs.queued,
    },
    counts: { projects: active.n, archivedProjects: archived.n, repositories: repoCount.n, gitConnections: connCount.n, people: people.n },
  }
}
