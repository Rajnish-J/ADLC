// The sync job queue. In-process (one API instance today), with the queue's state in repo_syncs so the history is
// kept and jobs interrupted by a restart run again. One job at a time per repository; REPO_JOB_CONCURRENCY overall.
// An identical job already waiting is reused instead of queued twice.

import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type { RepoStatus, RepoSyncTrigger } from '@sdlc/contracts'
import { writeAudit } from '../audit'
import { projectRepositories, projects, repoSyncs } from '../db/schema'
import { GitError, redact } from './git'
import { runSync, type SyncJob } from './indexer'
import type { RepoRuntime } from './runtime'
import { assertHasRemote } from './workspace'

export type SyncRow = typeof repoSyncs.$inferSelect

/** Full syncs change the repository's own status; branch jobs (open a branch, after a commit) don't. */
const FULL_SYNC_TRIGGERS: ReadonlySet<RepoSyncTrigger> = new Set(['link', 'manual', 'startup'])
/** Only syncs a person asked for are audited — opening a branch shouldn't flood the activity log. */
const AUDITED_TRIGGERS: ReadonlySet<RepoSyncTrigger> = new Set(['link', 'manual'])

export class RepoManager {
  private readonly queue: SyncJob[] = []
  private readonly runningRepos = new Set<string>()
  private active = 0
  private stopped = false

  constructor(readonly rt: RepoRuntime) {}

  /** Queue a sync (or reuse an identical one still waiting). */
  async enqueue(
    repositoryId: string,
    trigger: RepoSyncTrigger,
    opts: { branch?: string | null; requestedBy?: string | null; via: string },
  ): Promise<SyncRow> {
    const branch = opts.branch ?? null
    // Workspaces have no remote to sync from.
    const [repo] = await this.rt.db.select({ provider: projectRepositories.provider }).from(projectRepositories).where(eq(projectRepositories.id, repositoryId)).limit(1)
    if (repo) assertHasRemote(repo)
    const [waiting] = await this.rt.db
      .select()
      .from(repoSyncs)
      .where(
        and(
          eq(repoSyncs.repositoryId, repositoryId),
          eq(repoSyncs.status, 'queued'),
          branch === null ? isNull(repoSyncs.branch) : eq(repoSyncs.branch, branch),
        ),
      )
      .limit(1)
    if (waiting) return waiting

    const [row] = await this.rt.db
      .insert(repoSyncs)
      .values({ repositoryId, trigger, branch, requestedBy: opts.requestedBy ?? null })
      .returning()
    this.queue.push({ id: row.id, repositoryId, trigger, branch, requestedBy: row.requestedBy, via: opts.via })
    await this.publish(repositoryId, branch, row.id)
    this.pump()
    return row
  }

  /** After a restart: jobs that were running or waiting run again. */
  async resume(): Promise<void> {
    const interrupted = await this.rt.db
      .update(repoSyncs)
      .set({ status: 'queued', startedAt: null })
      .where(eq(repoSyncs.status, 'running'))
      .returning({ id: repoSyncs.id })
    const waiting = await this.rt.db.select().from(repoSyncs).where(eq(repoSyncs.status, 'queued')).orderBy(asc(repoSyncs.createdAt))
    if (waiting.length === 0) return
    if (!this.rt.git.ok) {
      await this.rt.db
        .update(repoSyncs)
        .set({ status: 'failed', error: this.rt.git.error, finishedAt: new Date() })
        .where(inArray(repoSyncs.id, waiting.map((w) => w.id)))
      return
    }
    const resumed = new Set(interrupted.map((r) => r.id))
    for (const w of waiting) {
      this.queue.push({
        id: w.id,
        repositoryId: w.repositoryId,
        trigger: resumed.has(w.id) && w.trigger !== 'branch' && w.trigger !== 'commit' ? 'startup' : w.trigger,
        branch: w.branch,
        requestedBy: w.requestedBy,
        via: 'api',
      })
    }
    this.rt.log.info({ jobs: waiting.length }, 'Resuming repository syncs')
    this.pump()
  }

  stop(): void {
    this.stopped = true
  }

  /** The job waiting or running for a repository right now, if any. */
  /** Jobs running and waiting right now (for Settings → System). */
  stats(): { running: number; queued: number } {
    return { running: this.active, queued: this.queue.length }
  }

  isBusy(repositoryId: string): boolean {
    return this.runningRepos.has(repositoryId) || this.queue.some((j) => j.repositoryId === repositoryId)
  }

  private pump(): void {
    while (!this.stopped && this.active < this.rt.concurrency) {
      const i = this.queue.findIndex((j) => !this.runningRepos.has(j.repositoryId))
      if (i < 0) return
      const [job] = this.queue.splice(i, 1)
      this.active++
      this.runningRepos.add(job.repositoryId)
      void this.run(job).finally(() => {
        this.active--
        this.runningRepos.delete(job.repositoryId)
        this.pump()
      })
    }
  }

  private async run(job: SyncJob): Promise<void> {
    const { db, log } = this.rt
    const full = FULL_SYNC_TRIGGERS.has(job.trigger) && job.branch === null
    const [repo] = await db.select().from(projectRepositories).where(eq(projectRepositories.id, job.repositoryId)).limit(1)
    if (!repo) {
      await db.update(repoSyncs).set({ status: 'failed', error: 'The repository was disconnected.', finishedAt: new Date() }).where(eq(repoSyncs.id, job.id))
      return
    }
    const [project] = await db.select({ id: projects.id, key: projects.key, orgId: projects.orgId }).from(projects).where(eq(projects.id, repo.projectId)).limit(1)

    await db.update(repoSyncs).set({ status: 'running', startedAt: new Date() }).where(eq(repoSyncs.id, job.id))
    if (full) await db.update(projectRepositories).set({ status: 'syncing', updatedAt: new Date() }).where(eq(projectRepositories.id, repo.id))
    await this.publish(repo.id, job.branch, job.id)

    try {
      const result = await runSync(this.rt, job)
      await db.update(repoSyncs).set({ status: 'succeeded', stats: result.stats, finishedAt: new Date() }).where(eq(repoSyncs.id, job.id))
      await db
        .update(projectRepositories)
        .set(
          full || repo.status !== 'failed'
            ? { status: 'ready', lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() }
            : { lastSyncedAt: new Date(), updatedAt: new Date() },
        )
        .where(eq(projectRepositories.id, repo.id))
      if (project && AUDITED_TRIGGERS.has(job.trigger)) {
        await db.transaction((tx) =>
          writeAudit(tx, {
            orgId: project.orgId,
            projectId: project.id,
            actorUserId: job.requestedBy,
            action: 'repo.synced',
            resourceType: 'repository',
            resourceId: repo.id,
            data: {
              repository: repo.displayName,
              branches: result.stats.branches.map((b) => ({ name: b.name, files: b.files, added: b.added, changed: b.changed, removed: b.removed, ignored: b.ignored })),
              agents: result.stats.catalog?.agents ?? 0,
              skills: result.stats.catalog?.skills ?? 0,
            },
            via: job.via,
          }),
        )
      }
      if (project && result.catalog?.changed) {
        this.rt.bus.publish({ type: 'project.changed', projectKey: project.key, action: 'agents', actorId: job.requestedBy })
      }
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err))
      log.warn({ repositoryId: repo.id, trigger: job.trigger, detail: err instanceof GitError ? err.detail : undefined, err: err instanceof GitError ? undefined : err }, `Repository sync failed: ${message}`)
      await db.update(repoSyncs).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(repoSyncs.id, job.id))
      await db
        .update(projectRepositories)
        .set(full ? { status: 'failed', lastError: message, updatedAt: new Date() } : { lastError: message, updatedAt: new Date() })
        .where(eq(projectRepositories.id, repo.id))
      if (project && AUDITED_TRIGGERS.has(job.trigger)) {
        await db.transaction((tx) =>
          writeAudit(tx, {
            orgId: project.orgId,
            projectId: project.id,
            actorUserId: job.requestedBy,
            action: 'repo.sync_failed',
            resourceType: 'repository',
            resourceId: repo.id,
            data: { repository: repo.displayName, error: message },
            via: job.via,
          }),
        )
      }
    }
    await this.publish(repo.id, job.branch, job.id)
  }

  /** Tell the project's clients the repository (or one branch) changed; they refetch. */
  async publish(repositoryId: string, branch: string | null, syncId: string | null, actorId: string | null = null): Promise<void> {
    const [row] = await this.rt.db
      .select({ key: projects.key, status: projectRepositories.status })
      .from(projectRepositories)
      .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
      .where(eq(projectRepositories.id, repositoryId))
      .limit(1)
    if (!row) return
    this.rt.bus.publish({ type: 'repo.changed', projectKey: row.key, status: row.status as RepoStatus, branch, syncId, actorId })
  }
}
