// The project profile, written by the built-in "Project profiler" agent (packages/core/agents/project-profiler.md).
//
// - Generate: a lead picks a branch of the linked repository; the profiler reads the indexed files from the database
//   (counted facts, manifests, docs, CI), adds platform facts (stories, runs) and writes all six sections. Runs in the
//   background; the web and VS Code follow `profile.changed`. A lead's generation is accepted straight away.
// - Update: when a run that changed files completes (from the web or VS Code), the profiler folds it into the
//   accepted profile as a *proposal* a lead accepts or rejects. Runs that end close together (and the late final
//   changes VS Code reports) are folded into one proposal after a short quiet period.
// - Agents: the accepted profile is the first section of every run's memory context (see memoryContext.ts).
//
// Without an AI model the profile holds only what could be counted from the repository; run updates are skipped.

import { generateText, Output } from 'ai'
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import {
  can,
  PROFILE_SECTION_KEYS,
  readProjectSettings,
  renderProfileMarkdown,
  type DecideProfileInput,
  type GenerateProfileInput,
  type ProfileChange,
  type ProfileContent,
  type ProfileVersionSummary,
  type ProjectProfile,
  type ProjectProfileState,
  type UpdateProfileInput,
} from '@sdlc/contracts'
import { collectProfileEvidence, profileFilesToRead, renderProfileEvidence } from '@sdlc/core'
import { assertCan, loadProjectAccess, type ProjectAccess } from '../access'
import type { AuthUser } from '../auth'
import { writeAudit } from '../audit'
import { createChatRuntime, type ChatRuntime } from '../chat/llm'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { projectProfiles } from '../db/profileSchema'
import { memoryItems, projects, repoBranches, runChanges, runSteps, runs, stories } from '../db/schema'
import { loadBuiltinAgents } from '../db/seedAgents'
import { usersById } from '../dto'
import type { EventBus } from '../events'
import { conflict, HttpError, isUniqueViolation, notFound } from '../http'
import { branchFilePaths, indexedBranchOf, readBranchFiles, repositoryOfProject } from '../repo/branchFiles'
import type { Caller } from './context'
import {
  clampSections,
  deterministicProfile,
  inputHash,
  mergeChangelog,
  ModelProfileSchema,
  profileContextMarkdown,
  renderFacts,
  renderMemoryForProfile,
  renderProfileForUpdate,
  renderRunsForUpdate,
  stackOf,
  type ModelProfile,
  type PlatformFacts,
  type RunForProfile,
} from './profileContent'

type ProfileRow = typeof projectProfiles.$inferSelect
type ProjectRow = typeof projects.$inferSelect

interface Logger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export const PROFILER_SLUG = 'project-profiler'
const OPEN = ['generating', 'proposed'] as const
/** How far back a restart looks for completed runs whose profile update was still waiting (lost with the timers). */
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1_000
/** A change report this long after the run finished is not its late final report; it does not re-fold the run. */
const LATE_REPORT_MS = 24 * 60 * 60 * 1_000

/**
 * The candidate runs already folded into a profile version, which are not folded again. The exception: VS Code's
 * report of the run's changes (`run_changes.updated_at`) came after the version that folded it was last written,
 * and within a day of the run finishing — the fold only saw the steps' files, so it is folded again with the exact
 * changes (once more per late report; a report repeated much later does not re-fold). Pure — unit-tested.
 */
export function alreadyFolded(
  folded: { runIds: string[]; at: Date }[],
  reports: ReadonlyMap<string, { at: Date; finishedAt: Date | null }>,
): Set<string> {
  const lastFold = new Map<string, Date>()
  for (const f of folded) {
    for (const id of f.runIds) {
      const prev = lastFold.get(id)
      if (!prev || f.at > prev) lastFold.set(id, f.at)
    }
  }
  const seen = new Set<string>()
  for (const [id, foldedAt] of lastFold) {
    const report = reports.get(id)
    const late = report && report.at > foldedAt && report.finishedAt && report.at.getTime() - report.finishedAt.getTime() <= LATE_REPORT_MS
    if (!late) seen.add(id)
  }
  return seen
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

async function accepted(db: Db, projectId: string): Promise<ProfileRow | null> {
  const [row] = await db
    .select()
    .from(projectProfiles)
    .where(and(eq(projectProfiles.projectId, projectId), eq(projectProfiles.status, 'accepted')))
    .limit(1)
  return row ?? null
}

async function openRow(db: Db, projectId: string): Promise<ProfileRow | null> {
  const [row] = await db
    .select()
    .from(projectProfiles)
    .where(and(eq(projectProfiles.projectId, projectId), inArray(projectProfiles.status, [...OPEN])))
    .limit(1)
  return row ?? null
}

async function nextVersion(db: Db | Parameters<Parameters<Db['transaction']>[0]>[0], projectId: string): Promise<number> {
  const [r] = await db
    .select({ max: sql<number>`coalesce(max(${projectProfiles.version}), 0)` })
    .from(projectProfiles)
    .where(eq(projectProfiles.projectId, projectId))
  return Number(r?.max ?? 0) + 1
}

/** The accepted profile as agents get it (compact Markdown), or '' when the project has none. */
export async function acceptedProfileContext(db: Db, projectId: string, maxChars = 5_000): Promise<string> {
  return (await acceptedProfileForRun(db, projectId, maxChars))?.markdown ?? ''
}

/**
 * The accepted profile as agents get it, with its version and the id of its mirrored memory item ("Project profile
 * vN", see syncProfileMemory) so a run can record that it was given the profile. Null when the project has none.
 */
export async function acceptedProfileForRun(
  db: Db,
  projectId: string,
  maxChars = 5_000,
): Promise<{ markdown: string; version: number; memoryItemId: string | null } | null> {
  const row = await accepted(db, projectId)
  if (!row?.content) return null
  const markdown = profileContextMarkdown(row.content, maxChars)
  if (!markdown) return null
  const [item] = await db
    .select({ id: memoryItems.id })
    .from(memoryItems)
    .where(and(eq(memoryItems.projectId, projectId), eq(memoryItems.source, 'profile'), eq(memoryItems.sourceRef, `profile:${row.id}`)))
    .limit(1)
  return { markdown, version: row.version, memoryItemId: item?.id ?? null }
}

async function present(db: Db, access: ProjectAccess, rows: ProfileRow[]): Promise<ProjectProfile[]> {
  const people = await usersById(db, rows.flatMap((r) => [r.createdBy, r.decidedBy]))
  const curator = can(access.actor, access.role, 'memory.curate')
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    status: r.status,
    trigger: r.trigger,
    branch: r.branch,
    commitSha: r.commitSha,
    content: r.content ?? null,
    markdown: r.markdown,
    aiWritten: r.aiWritten,
    model: r.model,
    error: r.error,
    runIds: r.runIds,
    basedOnId: r.basedOnId,
    createdBy: r.createdBy ? (people.get(r.createdBy) ?? null) : null,
    decidedBy: r.decidedBy ? (people.get(r.decidedBy) ?? null) : null,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionComment: r.decisionComment,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    actions: {
      canEdit: curator && (r.status === 'proposed' || r.status === 'accepted') && r.content !== null,
      canDecide: curator && r.status === 'proposed',
    },
  }))
}

async function loadRow(db: Db, access: ProjectAccess, id: string): Promise<ProfileRow> {
  const [row] = await db
    .select()
    .from(projectProfiles)
    .where(and(eq(projectProfiles.id, id), eq(projectProfiles.projectId, access.project.id)))
    .limit(1)
  if (!row) throw notFound('Profile version')
  return row
}

// ─── Platform facts ──────────────────────────────────────────────────────────────────────────────

async function platformFacts(db: Db, project: ProjectRow, branch: { name: string; indexedSha: string | null; commitMessage: string | null; commitAuthor: string | null; committedAt: Date | null } | null): Promise<PlatformFacts> {
  const counts = await db
    .select({ status: stories.status, n: sql<number>`count(*)::int` })
    .from(stories)
    .where(eq(stories.projectId, project.id))
    .groupBy(stories.status)
  const recent = await db
    .select({ workflow: runs.workflowName, status: runs.status, finishedAt: runs.finishedAt, storyNumber: stories.number, storyTitle: stories.title })
    .from(runs)
    .leftJoin(stories, eq(stories.id, runs.storyId))
    .where(eq(runs.projectId, project.id))
    .orderBy(desc(runs.startedAt))
    .limit(10)
  const [rate] = await db
    .select({
      done: sql<number>`count(*) filter (where ${runs.status} = 'completed')::int`,
      ended: sql<number>`count(*) filter (where ${runs.status} in ('completed', 'failed'))::int`,
    })
    .from(runs)
    .where(eq(runs.projectId, project.id))
  return {
    projectName: project.name,
    projectKey: project.key,
    description: project.description ?? '',
    branch: branch?.name ?? '(unknown)',
    commit: {
      sha: branch?.indexedSha ?? null,
      message: branch?.commitMessage ?? null,
      author: branch?.commitAuthor ?? null,
      at: branch?.committedAt?.toISOString() ?? null,
    },
    stories: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    recentRuns: recent.map((r) => ({
      workflow: r.workflow,
      status: r.status,
      story: r.storyNumber !== null ? `${project.key}-${r.storyNumber} ${r.storyTitle ?? ''}`.trim() : null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
    successRate: rate && rate.ended > 0 ? Math.round((rate.done / rate.ended) * 100) : null,
  }
}

// ─── The profile in project memory ────────────────────────────────────────────────────────────────

const PROFILE_MEMORY_MAX = 20_000

/**
 * Mirror an accepted profile version into project memory, so it is listed with the rest of what the project knows:
 * one item per version ("Project profile v3"), the newest accepted, earlier ones archived ("Replaced by v3").
 * Platform-managed — people can't edit, pin or archive it (memoryPresent), runs get the profile through its own
 * context section (not this item), and the profiler never reads it back. Idempotent.
 */
export async function syncProfileMemory(db: Db, bus: EventBus, row: ProfileRow): Promise<void> {
  if (row.status !== 'accepted' || !row.content) return
  const [project] = await db.select({ key: projects.key, orgId: projects.orgId }).from(projects).where(eq(projects.id, row.projectId)).limit(1)
  if (!project) return
  const sourceRef = `profile:${row.id}`
  const content = row.markdown.length > PROFILE_MEMORY_MAX ? `${row.markdown.slice(0, PROFILE_MEMORY_MAX).trimEnd()}\n…` : row.markdown
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .insert(memoryItems)
      .values({
        orgId: project.orgId,
        projectId: row.projectId,
        scope: 'project',
        kind: 'summary',
        status: 'accepted',
        title: `Project profile v${row.version}`,
        content,
        tags: ['project-profile', `v${row.version}`],
        source: 'profile',
        sourceRef,
        createdBy: row.createdBy,
        decidedBy: row.decidedBy,
        decidedAt: row.decidedAt ?? now,
      })
      .onConflictDoUpdate({
        target: [memoryItems.projectId, memoryItems.source, memoryItems.sourceRef],
        targetWhere: sql`${memoryItems.sourceRef} is not null`,
        set: { content, title: `Project profile v${row.version}`, status: 'accepted', decisionComment: null, updatedAt: now },
      })
    await tx
      .update(memoryItems)
      .set({ status: 'archived', pinned: false, decisionComment: `Replaced by v${row.version}`, updatedAt: now })
      .where(
        and(
          eq(memoryItems.projectId, row.projectId),
          eq(memoryItems.source, 'profile'),
          sql`${memoryItems.sourceRef} <> ${sourceRef}`,
          sql`${memoryItems.status} <> 'archived'`,
        ),
      )
  })
  bus.publish({ type: 'memory.changed', projectKey: project.key, storyNumber: null, action: 'profile', actorId: null })
}

// ─── Project memory the profiler reads ─────────────────────────────────────────────────────────────

/** Accepted project memory as profiler input, or '' when the project turned that off (AI settings). */
async function memoryForProfile(db: Db, project: ProjectRow): Promise<string> {
  if (!readProjectSettings(project.settings).ai.profileIncludesMemory) return ''
  const items = await db
    .select({ kind: memoryItems.kind, title: memoryItems.title, content: memoryItems.content, pinned: memoryItems.pinned, updatedAt: memoryItems.updatedAt })
    .from(memoryItems)
    .where(and(eq(memoryItems.projectId, project.id), eq(memoryItems.scope, 'project'), eq(memoryItems.status, 'accepted'), ne(memoryItems.source, 'profile')))
    .orderBy(desc(memoryItems.pinned), desc(memoryItems.updatedAt))
    .limit(80)
  return renderMemoryForProfile(items.map((i) => ({ ...i, updatedAt: i.updatedAt.toISOString() })))
}

const profileModelOf = (project: ProjectRow): string | null => readProjectSettings(project.settings).ai.profileModel

// ─── The service ─────────────────────────────────────────────────────────────────────────────────

export interface ProfileService {
  readonly aiEnabled: boolean
  state(user: AuthUser, key: string): Promise<ProjectProfileState>
  versions(user: AuthUser, key: string): Promise<ProfileVersionSummary[]>
  version(user: AuthUser, key: string, id: string): Promise<ProjectProfile>
  generate(caller: Caller, key: string, input: GenerateProfileInput): Promise<ProjectProfile>
  decide(caller: Caller, key: string, id: string, input: DecideProfileInput): Promise<ProjectProfile>
  update(caller: Caller, key: string, id: string, input: UpdateProfileInput): Promise<ProjectProfile>
  download(user: AuthUser, key: string, id?: string): Promise<{ fileName: string; markdown: string }>
  /** A run reached a terminal state: if it completed with changes, fold it into a proposal (debounced). */
  runEnded(runId: string): void
  /** On startup: generations interrupted by a restart are marked failed. */
  resume(): Promise<void>
  stop(): void
  /** Tests: run the pending run updates now instead of after the quiet period. */
  flush(): Promise<void>
}

export interface ProfileServiceOptions {
  runtime?: ChatRuntime
  debounceMs?: number
  /** Tests: replaces the model call. */
  callModel?: (mode: 'generate' | 'update', system: string, prompt: string) => Promise<{ profile: ModelProfile; model: string }>
}

const FALLBACK_SYSTEM = 'You write a software project profile from the evidence given. Use only that evidence; never invent facts or include secret values.'

export function createProfileService(deps: { db: Db; bus: EventBus }, config: Config, log: Logger, options: ProfileServiceOptions = {}): ProfileService {
  const { db, bus } = deps
  const runtime = options.runtime ?? createChatRuntime(config)
  const aiEnabled = Boolean(options.callModel) || runtime.config.enabled

  let system: string | null = null
  function profilerInstructions(): string {
    if (system) return system
    try {
      system = loadBuiltinAgents().find((a) => a.slug === PROFILER_SLUG)?.instructions ?? FALLBACK_SYSTEM
    } catch (err) {
      log.warn({ err }, 'Could not load the project-profiler agent file; using the fallback instructions')
      system = FALLBACK_SYSTEM
    }
    return system
  }

  async function callModel(mode: 'generate' | 'update', prompt: string, modelId: string | null): Promise<{ profile: ModelProfile; model: string }> {
    if (options.callModel) return options.callModel(mode, profilerInstructions(), prompt)
    const { model, info } = runtime.model(modelId)
    const result = await generateText({
      model,
      system: profilerInstructions(),
      prompt,
      output: Output.object({ schema: ModelProfileSchema }),
      maxOutputTokens: 16_000,
      abortSignal: AbortSignal.timeout(180_000),
    })
    return { profile: result.output as ModelProfile, model: info.label }
  }

  function publish(projectKey: string, profileId: string, status: ProfileRow['status'], actorId: string | null): void {
    bus.publish({ type: 'profile.changed', projectKey, profileId, status, actorId })
  }

  // One job at a time per project; jobs never throw out of the chain.
  const chains = new Map<string, Promise<void>>()
  function enqueue(projectId: string, label: string, job: () => Promise<void>): Promise<void> {
    const prev = chains.get(projectId) ?? Promise.resolve()
    const next = prev
      .then(job)
      .catch((err) => log.error({ err, projectId }, `Project profile ${label} failed`))
      .finally(() => {
        if (chains.get(projectId) === next) chains.delete(projectId)
      })
    chains.set(projectId, next)
    return next
  }

  // ── Generate ──

  async function runGenerate(rowId: string, project: ProjectRow, branchName: string | null, via: string): Promise<void> {
    try {
      const repo = await repositoryOfProject(db, project.id)
      if (!repo) throw new Error('The project no longer has a linked repository.')
      const branch = await indexedBranchOf(db, repo, branchName)
      const paths = await branchFilePaths(db, branch.id)
      const contents = await readBranchFiles(db, repo.id, branch.id, profileFilesToRead(paths))
      const evidence = collectProfileEvidence(paths, contents)
      const facts = await platformFacts(db, project, branch)
      const memory = await memoryForProfile(db, project)
      const evidenceText = [renderProfileEvidence(evidence), renderFacts(facts), memory].filter(Boolean).join('\n\n')

      let body = deterministicProfile(evidence, facts)
      let aiWritten = false
      let model: string | null = null
      let note: string | null = null
      if (aiEnabled) {
        try {
          const prompt = [
            `# Task: generate`,
            `Write the project profile for "${project.name}" (${project.key}) from the evidence below, read from branch "${branch.name}". Fill every section. \`changes\` must be an empty list.`,
            '',
            evidenceText,
          ].join('\n')
          const out = await callModel('generate', prompt, profileModelOf(project))
          body = { headline: out.profile.headline.trim().slice(0, 400), maturity: out.profile.maturity, sections: clampSections(out.profile.sections) }
          aiWritten = true
          model = out.model
        } catch (err) {
          log.warn({ err, projectId: project.id }, 'The profiler model failed; keeping the counted profile')
          note = `The AI model did not answer (${err instanceof Error ? err.message : String(err)}); this version holds only what was counted from the repository.`
        }
      }

      const previous = await accepted(db, project.id)
      const sha = branch.indexedSha?.slice(0, 7) ?? ''
      const entry: ProfileChange = {
        at: new Date().toISOString(),
        runId: null,
        summary: `${previous ? 'Regenerated' : 'Generated'} from ${branch.name}${sha ? ` @ ${sha}` : ''}${aiWritten ? '' : ' (counted facts only)'}`,
      }
      const content: ProfileContent = { ...body, stack: stackOf(evidence), changelog: mergeChangelog(previous?.content?.changelog ?? [], [entry]) }

      const done = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(projectProfiles).where(eq(projectProfiles.id, rowId)).for('update').limit(1)
        if (!row || row.status !== 'generating') return null
        await tx
          .update(projectProfiles)
          .set({ status: 'superseded', updatedAt: new Date() })
          .where(and(eq(projectProfiles.projectId, project.id), eq(projectProfiles.status, 'accepted')))
        const now = new Date()
        await tx
          .update(projectProfiles)
          .set({
            status: 'accepted',
            branch: branch.name,
            commitSha: branch.indexedSha,
            content,
            markdown: renderProfileMarkdown(project.name, content, { branch: branch.name, version: row.version }),
            aiWritten,
            inputHash: inputHash(evidenceText),
            model,
            error: note,
            decidedBy: row.createdBy,
            decidedAt: now,
            updatedAt: now,
          })
          .where(eq(projectProfiles.id, rowId))
        await writeAudit(tx, {
          orgId: project.orgId,
          projectId: project.id,
          actorUserId: row.createdBy,
          action: 'profile.generated',
          resourceType: 'project_profile',
          resourceId: rowId,
          data: { version: row.version, branch: branch.name, aiWritten },
          via,
        })
        return row
      })
      if (done) {
        publish(project.key, rowId, 'accepted', done.createdBy)
        const [saved] = await db.select().from(projectProfiles).where(eq(projectProfiles.id, rowId)).limit(1)
        if (saved) await syncProfileMemory(db, bus, saved)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await db
        .update(projectProfiles)
        .set({ status: 'failed', error: message.slice(0, 2_000), updatedAt: new Date() })
        .where(and(eq(projectProfiles.id, rowId), eq(projectProfiles.status, 'generating')))
      publish(project.key, rowId, 'failed', null)
      throw err
    }
  }

  async function generate(caller: Caller, key: string, input: GenerateProfileInput): Promise<ProjectProfile> {
    const access = await loadProjectAccess(db, caller.user, key)
    assertCan(access, 'memory.curate')
    const project = access.project
    const repo = await repositoryOfProject(db, project.id)
    if (!repo) throw new HttpError(409, 'no_repository', 'Link a repository to the project first (Settings → Repository).')
    const branch = await indexedBranchOf(db, repo, input.branch) // 409 branch_not_indexed → the client opens it first

    let row: ProfileRow
    try {
      row = await db.transaction(async (tx) => {
        const [open] = await tx
          .select()
          .from(projectProfiles)
          .where(and(eq(projectProfiles.projectId, project.id), inArray(projectProfiles.status, [...OPEN])))
          .for('update')
          .limit(1)
        if (open?.status === 'generating') throw conflict('The profile is already being generated.')
        if (open?.status === 'proposed') {
          await tx
            .update(projectProfiles)
            .set({ status: 'superseded', decisionComment: 'Replaced by a new generation.', updatedAt: new Date() })
            .where(eq(projectProfiles.id, open.id))
        }
        const [created] = await tx
          .insert(projectProfiles)
          .values({
            orgId: project.orgId,
            projectId: project.id,
            version: await nextVersion(tx, project.id),
            status: 'generating',
            trigger: 'manual',
            branch: branch.name,
            commitSha: branch.indexedSha,
            createdBy: caller.user.id,
          })
          .returning()
        return created
      })
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('The profile is already being generated.')
      throw err
    }
    publish(project.key, row.id, 'generating', caller.user.id)
    void enqueue(project.id, 'generation', () => runGenerate(row.id, project, branch.name, caller.via))
    const [shown] = await present(db, access, [row])
    return shown
  }

  // ── Update after runs ──

  const pending = new Map<string, Set<string>>()
  const timers = new Map<string, NodeJS.Timeout>()

  async function runsForUpdate(projectKey: string, ids: string[]): Promise<RunForProfile[]> {
    if (!ids.length) return []
    const rows = await db
      .select({ run: runs, storyNumber: stories.number, storyTitle: stories.title, changes: runChanges })
      .from(runs)
      .leftJoin(stories, eq(stories.id, runs.storyId))
      .leftJoin(runChanges, eq(runChanges.runId, runs.id))
      .where(and(inArray(runs.id, ids), eq(runs.status, 'completed')))
    const steps = await db
      .select({ runId: runSteps.runId, seq: runSteps.seq, kind: runSteps.kind, output: runSteps.output })
      .from(runSteps)
      .where(inArray(runSteps.runId, ids))
    const lastOutput = new Map<string, { seq: number; output: string }>()
    for (const s of steps) {
      if (s.kind !== 'agent' || !s.output) continue
      const prev = lastOutput.get(s.runId)
      if (!prev || s.seq > prev.seq) lastOutput.set(s.runId, { seq: s.seq, output: s.output })
    }
    return rows
      .map(({ run, storyNumber, storyTitle, changes }) => ({
        id: run.id,
        workflowName: run.workflowName,
        story: storyNumber !== null ? `${projectKey}-${storyNumber} ${storyTitle ?? ''}`.trim() : null,
        prompt: run.prompt,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        branch: changes?.branch ?? null,
        files: changes?.files ?? [],
        changedFiles: run.changedFiles,
        patch: changes?.patch ?? null,
        summary: lastOutput.get(run.id)?.output ?? null,
      }))
      .filter((r) => r.files.length > 0 || r.changedFiles.length > 0)
      .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''))
  }

  async function runUpdate(projectId: string, candidateIds: string[]): Promise<void> {
    if (!aiEnabled) return
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
    const current = await accepted(db, projectId)
    if (!project || !current?.content) return
    if (!readProjectSettings(project.settings).ai.autoProposeProfile) return
    const open = await openRow(db, projectId)
    if (open?.status === 'generating') {
      log.info({ projectId }, 'Project profile is being regenerated; skipping the run update')
      return
    }
    // Runs already folded into any version (accepted, proposed or rejected) are not folded again — unless VS Code's
    // report of the run's changes arrived after that fold (see alreadyFolded).
    const candidates = sql.join(candidateIds.map((id) => sql`${id}`), sql`, `)
    const folded = await db
      .select({ ids: projectProfiles.runIds, at: projectProfiles.updatedAt })
      .from(projectProfiles)
      .where(and(eq(projectProfiles.projectId, projectId), sql`${projectProfiles.runIds} && ARRAY[${candidates}]::uuid[]`))
    const reported = await db
      .select({ runId: runChanges.runId, at: runChanges.updatedAt, finishedAt: runs.finishedAt })
      .from(runChanges)
      .innerJoin(runs, eq(runs.id, runChanges.runId))
      .where(inArray(runChanges.runId, candidateIds))
    const seen = alreadyFolded(
      folded.map((f) => ({ runIds: f.ids, at: f.at })),
      new Map(reported.map((r) => [r.runId, { at: r.at, finishedAt: r.finishedAt }])),
    )
    const fresh = await runsForUpdate(project.key, candidateIds.filter((id) => !seen.has(id)))
    if (!fresh.length) return

    const base = open?.status === 'proposed' && open.content ? open.content : current.content
    const repo = await repositoryOfProject(db, projectId)
    const [branch] =
      repo && current.branch
        ? await db.select().from(repoBranches).where(and(eq(repoBranches.repositoryId, repo.id), eq(repoBranches.name, current.branch))).limit(1)
        : []
    const facts = await platformFacts(
      db,
      project,
      branch ?? (current.branch ? { name: current.branch, indexedSha: current.commitSha, commitMessage: null, commitAuthor: null, committedAt: null } : null),
    )
    const runsText = renderRunsForUpdate(fresh)
    const prompt = [
      '# Task: update',
      `Fold the runs below into the current profile of "${project.name}" (${project.key}). Keep everything that is still true; change only what the runs changed. Add one \`changes\` entry per run, with its run id.`,
      '',
      renderProfileForUpdate(base),
      '',
      runsText,
      '',
      renderFacts(facts),
      '',
      await memoryForProfile(db, project),
    ].join('\n')
    const out = await callModel('update', prompt, profileModelOf(project))
    const now = new Date().toISOString()
    const byId = new Map(fresh.map((r) => [r.id, r]))
    const changes: ProfileChange[] = out.profile.changes
      .filter((c) => byId.has(c.runId) && c.summary.trim())
      .map((c) => ({ at: byId.get(c.runId)?.finishedAt ?? now, runId: c.runId, summary: c.summary.trim().slice(0, 300) }))
    for (const r of fresh) {
      if (changes.some((c) => c.runId === r.id)) continue
      changes.push({ at: r.finishedAt ?? now, runId: r.id, summary: `${r.workflowName}: ${r.story ?? 'quick fix'} (${r.files.length || r.changedFiles.length} files)` })
    }
    const content: ProfileContent = {
      headline: out.profile.headline.trim().slice(0, 400) || base.headline,
      maturity: out.profile.maturity,
      sections: clampSections(out.profile.sections),
      stack: base.stack,
      changelog: mergeChangelog(base.changelog, changes),
    }
    const hash = inputHash(prompt)

    const saved = await db.transaction(async (tx) => {
      const [stillOpen] = await tx
        .select()
        .from(projectProfiles)
        .where(and(eq(projectProfiles.projectId, projectId), inArray(projectProfiles.status, [...OPEN])))
        .for('update')
        .limit(1)
      if (stillOpen?.status === 'generating') return null
      const runIds = [...new Set([...(stillOpen?.runIds ?? []), ...fresh.map((r) => r.id)])]
      let row: ProfileRow
      if (stillOpen) {
        ;[row] = await tx
          .update(projectProfiles)
          .set({ content, markdown: renderProfileMarkdown(project.name, content, { branch: current.branch, version: stillOpen.version }), runIds, model: out.model, inputHash: hash, updatedAt: new Date() })
          .where(eq(projectProfiles.id, stillOpen.id))
          .returning()
      } else {
        const version = await nextVersion(tx, projectId)
        ;[row] = await tx
          .insert(projectProfiles)
          .values({
            orgId: project.orgId,
            projectId,
            version,
            status: 'proposed',
            trigger: 'run',
            branch: current.branch,
            commitSha: current.commitSha,
            content,
            markdown: renderProfileMarkdown(project.name, content, { branch: current.branch, version }),
            aiWritten: true,
            inputHash: hash,
            model: out.model,
            runIds,
            basedOnId: current.id,
          })
          .returning()
      }
      await writeAudit(tx, {
        orgId: project.orgId,
        projectId,
        actorUserId: null,
        action: 'profile.proposed',
        resourceType: 'project_profile',
        resourceId: row.id,
        data: { version: row.version, runIds: fresh.map((r) => r.id) },
        via: 'platform',
      })
      return row
    })
    if (saved) {
      publish(project.key, saved.id, 'proposed', null)
      bus.publish({ type: 'memory.changed', projectKey: project.key, storyNumber: null, action: 'profile-proposed', actorId: null })
    }
  }

  function scheduleFlush(projectId: string, waitMs: number): void {
    const existing = timers.get(projectId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(projectId)
      const ids = [...(pending.get(projectId) ?? [])]
      pending.delete(projectId)
      if (ids.length) void enqueue(projectId, 'update', () => runUpdate(projectId, ids))
    }, waitMs)
    timer.unref?.()
    timers.set(projectId, timer)
  }

  function runEnded(runId: string): void {
    if (!aiEnabled) return
    void (async () => {
      const [run] = await db.select({ projectId: runs.projectId, status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1)
      if (!run || run.status !== 'completed') return
      const [project] = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, run.projectId)).limit(1)
      const ai = readProjectSettings(project?.settings).ai
      if (!ai.autoProposeProfile) return
      if (!(await accepted(db, run.projectId))) return
      const set = pending.get(run.projectId) ?? new Set<string>()
      set.add(runId)
      pending.set(run.projectId, set)
      // Tests pass a short window; otherwise the project's own (AI settings, default 90 s).
      scheduleFlush(run.projectId, options.debounceMs ?? ai.profileDebounceSeconds * 1_000)
    })().catch((err) => log.warn({ err, runId }, 'Could not schedule a project profile update'))
  }

  async function flush(): Promise<void> {
    for (const [projectId, timer] of timers) {
      clearTimeout(timer)
      timers.delete(projectId)
      const ids = [...(pending.get(projectId) ?? [])]
      pending.delete(projectId)
      if (ids.length) void enqueue(projectId, 'update', () => runUpdate(projectId, ids))
    }
    await Promise.all([...chains.values()])
  }

  // ── Decide, edit, read ──

  async function decide(caller: Caller, key: string, id: string, input: DecideProfileInput): Promise<ProjectProfile> {
    const access = await loadProjectAccess(db, caller.user, key)
    assertCan(access, 'memory.curate')
    const row = await loadRow(db, access, id)
    if (row.status !== 'proposed') throw conflict('Only a proposed profile can be accepted or rejected.')
    const now = new Date()
    const status = input.decision === 'accept' ? 'accepted' : 'rejected'
    await db.transaction(async (tx) => {
      if (status === 'accepted') {
        await tx
          .update(projectProfiles)
          .set({ status: 'superseded', updatedAt: now })
          .where(and(eq(projectProfiles.projectId, access.project.id), eq(projectProfiles.status, 'accepted')))
      }
      await tx
        .update(projectProfiles)
        .set({ status, decidedBy: caller.user.id, decidedAt: now, decisionComment: input.comment ?? null, updatedAt: now })
        .where(eq(projectProfiles.id, id))
      await writeAudit(tx, {
        orgId: access.project.orgId,
        projectId: access.project.id,
        actorUserId: caller.user.id,
        action: `profile.${status}`,
        resourceType: 'project_profile',
        resourceId: id,
        data: { version: row.version, comment: input.comment ?? null },
        via: caller.via,
      })
    })
    publish(access.project.key, id, status, caller.user.id)
    bus.publish({ type: 'memory.changed', projectKey: access.project.key, storyNumber: null, action: `profile-${status}`, actorId: caller.user.id })
    const decided = await loadRow(db, access, id)
    await syncProfileMemory(db, bus, decided)
    const [shown] = await present(db, access, [decided])
    return shown
  }

  async function update(caller: Caller, key: string, id: string, input: UpdateProfileInput): Promise<ProjectProfile> {
    const access = await loadProjectAccess(db, caller.user, key)
    assertCan(access, 'memory.curate')
    const row = await loadRow(db, access, id)
    if ((row.status !== 'proposed' && row.status !== 'accepted') || !row.content) throw conflict('Only the accepted profile or a proposal can be edited.')
    const sections = { ...row.content.sections }
    for (const k of PROFILE_SECTION_KEYS) {
      const edit = input.sections?.[k]
      if (edit) sections[k] = { ...sections[k], markdown: edit.markdown }
    }
    const content: ProfileContent = { ...row.content, headline: input.headline ?? row.content.headline, maturity: input.maturity ?? row.content.maturity, sections }
    await db.transaction(async (tx) => {
      await tx
        .update(projectProfiles)
        .set({ content, markdown: renderProfileMarkdown(access.project.name, content, { branch: row.branch, version: row.version }), updatedAt: new Date() })
        .where(eq(projectProfiles.id, id))
      await writeAudit(tx, {
        orgId: access.project.orgId,
        projectId: access.project.id,
        actorUserId: caller.user.id,
        action: 'profile.edited',
        resourceType: 'project_profile',
        resourceId: id,
        data: { version: row.version, sections: Object.keys(input.sections ?? {}) },
        via: caller.via,
      })
    })
    publish(access.project.key, id, row.status, caller.user.id)
    const edited = await loadRow(db, access, id)
    await syncProfileMemory(db, bus, edited)
    const [shown] = await present(db, access, [edited])
    return shown
  }

  async function state(user: AuthUser, key: string): Promise<ProjectProfileState> {
    const access = await loadProjectAccess(db, user, key)
    const current = await accepted(db, access.project.id)
    // The open version, or the newest failed generation (if it is newer than the accepted one).
    let pendingRow = await openRow(db, access.project.id)
    if (!pendingRow) {
      const [latest] = await db.select().from(projectProfiles).where(eq(projectProfiles.projectId, access.project.id)).orderBy(desc(projectProfiles.version)).limit(1)
      if (latest?.status === 'failed') pendingRow = latest
    }
    const shown = await present(db, access, [current, pendingRow].filter((r): r is ProfileRow => r !== null))
    return {
      current: current ? shown[0] : null,
      pending: pendingRow ? shown[current ? 1 : 0] : null,
      canGenerate: can(access.actor, access.role, 'memory.curate'),
      aiEnabled,
      aiReason: aiEnabled ? null : runtime.config.reason,
      hasRepository: (await repositoryOfProject(db, access.project.id)) !== null,
    }
  }

  async function versions(user: AuthUser, key: string): Promise<ProfileVersionSummary[]> {
    const access = await loadProjectAccess(db, user, key)
    const rows = await db.select().from(projectProfiles).where(eq(projectProfiles.projectId, access.project.id)).orderBy(desc(projectProfiles.version)).limit(100)
    return (await present(db, access, rows)).map((p) => ({
      id: p.id,
      version: p.version,
      status: p.status,
      trigger: p.trigger,
      branch: p.branch,
      commitSha: p.commitSha,
      aiWritten: p.aiWritten,
      runIds: p.runIds,
      createdBy: p.createdBy,
      decidedBy: p.decidedBy,
      createdAt: p.createdAt,
      decidedAt: p.decidedAt,
    }))
  }

  async function version(user: AuthUser, key: string, id: string): Promise<ProjectProfile> {
    const access = await loadProjectAccess(db, user, key)
    const [shown] = await present(db, access, [await loadRow(db, access, id)])
    return shown
  }

  async function download(user: AuthUser, key: string, id?: string): Promise<{ fileName: string; markdown: string }> {
    const access = await loadProjectAccess(db, user, key)
    const row = id ? await loadRow(db, access, id) : await accepted(db, access.project.id)
    if (!row?.content) throw notFound('Project profile')
    return { fileName: `${access.project.key.toLowerCase()}-project-profile-v${row.version}.md`, markdown: row.markdown }
  }

  async function resume(): Promise<void> {
    const rows = await db
      .update(projectProfiles)
      .set({ status: 'failed', error: 'Interrupted by a server restart — generate again.', updatedAt: new Date() })
      .where(eq(projectProfiles.status, 'generating'))
      .returning({ id: projectProfiles.id })
    if (rows.length) log.info({ count: rows.length }, 'Marked interrupted project profile generations as failed')
    // Profiles accepted before they were mirrored into memory (or while the mirror failed) are listed there now.
    for (const row of await db.select().from(projectProfiles).where(eq(projectProfiles.status, 'accepted'))) {
      await syncProfileMemory(db, bus, row).catch((err) => log.warn({ err, profileId: row.id }, 'Could not list the project profile in memory'))
    }
    await requeueMissedRuns().catch((err) => log.warn({ err }, 'Could not re-queue project profile updates after a restart'))
  }

  /**
   * Pending updates live only in memory (debounced), so a restart loses them. Re-queue completed runs of the last
   * day that changed files, finished while the project had an accepted profile, and are in no version's run ids.
   * runEnded re-checks the project's settings; runUpdate skips anything folded meanwhile.
   */
  async function requeueMissedRuns(): Promise<void> {
    if (!aiEnabled) return
    const since = new Date(Date.now() - RESUME_WINDOW_MS)
    const missed = await db
      .select({ id: runs.id })
      .from(runs)
      .leftJoin(runChanges, eq(runChanges.runId, runs.id))
      .where(
        and(
          eq(runs.status, 'completed'),
          gte(runs.finishedAt, since),
          sql`(cardinality(${runs.changedFiles}) > 0 or jsonb_array_length(coalesce(${runChanges.files}, '[]'::jsonb)) > 0)`,
          sql`exists (select 1 from ${projectProfiles} where ${projectProfiles.projectId} = ${runs.projectId} and ${projectProfiles.status} in ('accepted', 'superseded') and ${projectProfiles.decidedAt} <= ${runs.finishedAt})`,
          sql`not exists (select 1 from ${projectProfiles} where ${projectProfiles.projectId} = ${runs.projectId} and ${runs.id} = any(${projectProfiles.runIds}))`,
        ),
      )
      .limit(500)
    for (const r of missed) runEnded(r.id)
    if (missed.length) log.info({ count: missed.length }, 'Re-queued project profile updates for runs that finished before a restart')
  }

  function stop(): void {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    pending.clear()
  }

  return { aiEnabled, state, versions, version, generate, decide, update, download, runEnded, resume, stop, flush }
}
