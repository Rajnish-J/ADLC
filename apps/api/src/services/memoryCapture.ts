// Memory the platform records on its own, inside the transaction of the change that caused it:
//   • an agent run completes      → a `summary` (the prompt, what the last agent reported, which files changed)
//   • a quality gate fails / a plan is rejected with a comment → a `learning`
//   • a story is marked done      → a PROPOSED project `summary` (the story → project roll-up a lead accepts)
// A story run's items go to the story's memory (accepted); a quick fix (no story) proposes them to project memory
// for a lead to accept. Every item carries a `source_ref` (so capturing the same thing twice is a no-op) and the
// run it came from.

import { and, eq, sql } from 'drizzle-orm'
import { readProjectSettings, type AcceptanceCriterion, type ApprovalRecord, type ChangedFile, type ProjectMemorySettings } from '@sdlc/contracts'
import type { Tx } from '../db/client'
import { memoryItems, projects, runs, storyCommits } from '../db/schema'

export interface CaptureTarget {
  orgId: string
  projectId: string
  /** The story the run worked on; null for a quick fix (its items are proposed to project memory). */
  storyId: string | null
  /** Who the captured item is attributed to (the reporting developer, or whoever marked the story done). */
  userId: string | null
}

export interface CapturedStep {
  stepId: string
  kind: string
  label: string
  status: string
  seq: number
  output: string | null
  gatePass: boolean | null
  gateReason: string | null
  approval: ApprovalRecord | null
}

export interface CapturedRun {
  id: string
  workflowName: string
  status: string
  changedFiles: string[]
  /** The quick fix's prompt (or a story run's extra instructions). */
  prompt?: string | null
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text)

type NewItem = Omit<typeof memoryItems.$inferInsert, 'orgId' | 'projectId' | 'storyId' | 'createdBy' | 'scope' | 'status' | 'runId'>

/** The project's memory switches (Project settings → Memory); defaults when the project has none. */
export async function memoryPolicy(tx: Tx, projectId: string): Promise<ProjectMemorySettings> {
  const [row] = await tx.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId))
  return readProjectSettings(row?.settings).memory
}

/** A quick fix's project memory: accepted when the project accepts quick-fix memory, otherwise proposed for a lead. */
export function quickFixStatus(policy: Pick<ProjectMemorySettings, 'quickFixMemory'>): 'accepted' | 'proposed' {
  return policy.quickFixMemory === 'accept' ? 'accepted' : 'proposed'
}

/**
 * The status of a project item written through the API: one a quick fix's agent writes (a run with no story)
 * follows the project's quick-fix policy, like captured memory; anything else is accepted for a curator and
 * proposed otherwise. Pure — unit-tested.
 */
export function projectMemoryStatus(curator: boolean, run: { storyId: string | null } | null, policy: Pick<ProjectMemorySettings, 'quickFixMemory'>): 'accepted' | 'proposed' {
  if (run && !run.storyId) return quickFixStatus(policy)
  return curator ? 'accepted' : 'proposed'
}

/** A story run's items are the story's (accepted); a quick fix's go to project memory, proposed unless the project accepts them. */
function placement(target: CaptureTarget, policy: ProjectMemorySettings) {
  if (target.storyId) return { scope: 'story', status: 'accepted' } as const
  return { scope: 'project', status: quickFixStatus(policy) } as const
}

async function insertOnce(tx: Tx, target: CaptureTarget, policy: ProjectMemorySettings, runId: string | null, item: NewItem): Promise<boolean> {
  const inserted = await tx
    .insert(memoryItems)
    .values({ ...item, ...placement(target, policy), runId, orgId: target.orgId, projectId: target.projectId, storyId: target.storyId, createdBy: target.userId })
    .onConflictDoNothing({
      target: [memoryItems.projectId, memoryItems.source, memoryItems.sourceRef],
      where: sql`${memoryItems.sourceRef} is not null`,
    })
    .returning({ id: memoryItems.id })
  return inserted.length > 0
}

/**
 * The summary of a completed run: the quick fix's prompt, the last agent's report, and the files it changed (with
 * line counts when VS Code reported the run's changes). Pure — unit-tested.
 */
export function runSummaryContent(run: CapturedRun, steps: CapturedStep[], files: ChangedFile[] | null, isQuickFix: boolean): string {
  const parts: string[] = []
  if (isQuickFix && run.prompt?.trim()) parts.push('Prompt:', clip(run.prompt.trim(), 1_000), '')
  const lastAgent = [...steps].filter((s) => s.kind === 'agent' && s.output?.trim()).sort((a, b) => b.seq - a.seq)[0]
  if (lastAgent?.output) parts.push(`${lastAgent.label}:`, clip(lastAgent.output.trim(), 2_000))
  if (files?.length) {
    const additions = files.reduce((n, f) => n + f.additions, 0)
    const deletions = files.reduce((n, f) => n + f.deletions, 0)
    parts.push('', `Files changed (+${additions} −${deletions}):`)
    for (const f of files.slice(0, 30)) parts.push(`- ${f.path}${f.binary ? ' (binary)' : ` (+${f.additions} −${f.deletions})`}${f.status === 'added' || f.status === 'untracked' ? ' — new' : f.status === 'deleted' ? ' — deleted' : ''}`)
    if (files.length > 30) parts.push(`- … and ${files.length - 30} more`)
  } else if (run.changedFiles.length) {
    parts.push('', 'Files changed:', ...run.changedFiles.slice(0, 30).map((f) => `- ${f}`))
    if (run.changedFiles.length > 30) parts.push(`- … and ${run.changedFiles.length - 30} more`)
  }
  while (parts[0] === '') parts.shift()
  return parts.join('\n') || 'The run completed.'
}

/**
 * Capture memory from a finished (or still reporting) run. Returns how many items were recorded or refreshed.
 * The summary is refreshed when it is captured again — VS Code's last report of the run's changes can arrive after
 * the run ended — unless a lead has since rejected or archived it.
 */
export async function captureRunMemory(tx: Tx, target: CaptureTarget, run: CapturedRun, steps: CapturedStep[], files: ChangedFile[] | null = null): Promise<number> {
  const isQuickFix = !target.storyId
  const policy = await memoryPolicy(tx, target.projectId)
  let added = 0
  for (const step of policy.captureLearnings ? steps : []) {
    if (step.kind === 'gate' && step.gatePass === false && step.status !== 'running') {
      const ok = await insertOnce(tx, target, policy, run.id, {
        kind: 'learning',
        title: `Quality gate failed: ${clip(step.label, 120)}`,
        content: step.gateReason ? clip(step.gateReason, 2_000) : 'The gate did not pass.',
        source: 'run',
        sourceRef: `run:${run.id}:gate:${step.stepId}`,
      })
      if (ok) added++
    }
    if (step.approval && !step.approval.approve && step.approval.comment?.trim()) {
      const ok = await insertOnce(tx, target, policy, run.id, {
        kind: 'learning',
        title: `Not approved: ${clip(step.label, 120)}`,
        content: clip(step.approval.comment.trim(), 2_000),
        source: 'run',
        sourceRef: `run:${run.id}:approval:${step.stepId}`,
      })
      if (ok) added++
    }
  }

  if (run.status === 'completed' && policy.captureRunSummaries) {
    const title = isQuickFix
      ? `Quick fix: ${clip(run.prompt?.trim().split('\n')[0] || run.workflowName, 140)}`
      : `Run “${clip(run.workflowName, 100)}” completed`
    const content = runSummaryContent(run, steps, files, isQuickFix)
    const rows = await tx
      .insert(memoryItems)
      .values({
        ...placement(target, policy),
        orgId: target.orgId,
        projectId: target.projectId,
        storyId: target.storyId,
        createdBy: target.userId,
        runId: run.id,
        kind: 'summary',
        title,
        content,
        source: 'run',
        sourceRef: `run:${run.id}:summary`,
      })
      .onConflictDoUpdate({
        target: [memoryItems.projectId, memoryItems.source, memoryItems.sourceRef],
        targetWhere: sql`${memoryItems.sourceRef} is not null`,
        set: { content, runId: run.id, updatedAt: new Date() },
        setWhere: sql`${memoryItems.status} in ('proposed', 'accepted') and ${memoryItems.content} is distinct from ${content}`,
      })
      .returning({ id: memoryItems.id })
    if (rows.length) added++
  }
  return added
}

/**
 * When a story is marked done, propose a project-memory summary built from what happened on it — no AI, just the
 * record: criteria, commits, runs and the story's decisions and learnings. Marking it done again after a reopen
 * refreshes the proposal while it is still awaiting a lead.
 */
export async function captureStoryDone(
  tx: Tx,
  target: CaptureTarget & { storyId: string },
  story: { key: string; title: string; acceptanceCriteria: AcceptanceCriterion[] },
): Promise<boolean> {
  if (!(await memoryPolicy(tx, target.projectId)).proposeOnStoryDone) return false
  const commits = await tx
    .select({ files: storyCommits.files, additions: storyCommits.additions, deletions: storyCommits.deletions })
    .from(storyCommits)
    .where(eq(storyCommits.storyId, target.storyId))
  const runRows = await tx.select({ status: runs.status, workflowName: runs.workflowName }).from(runs).where(eq(runs.storyId, target.storyId))
  const notes = await tx
    .select({ kind: memoryItems.kind, title: memoryItems.title })
    .from(memoryItems)
    .where(and(eq(memoryItems.storyId, target.storyId), eq(memoryItems.scope, 'story'), eq(memoryItems.status, 'accepted')))

  const lines: string[] = [`Delivered ${story.key} — ${story.title}.`]
  if (story.acceptanceCriteria.length) {
    lines.push('', 'Acceptance criteria:', ...story.acceptanceCriteria.map((c) => `- [${c.met ? 'x' : ' '}] ${c.text}`))
  }
  const fileCounts = new Map<string, number>()
  let additions = 0
  let deletions = 0
  for (const c of commits) {
    additions += c.additions
    deletions += c.deletions
    for (const f of c.files) fileCounts.set(f.path, (fileCounts.get(f.path) ?? 0) + 1)
  }
  const work: string[] = []
  if (commits.length) work.push(`${commits.length} commit${commits.length === 1 ? '' : 's'} (+${additions} −${deletions}) across ${fileCounts.size} file${fileCounts.size === 1 ? '' : 's'}`)
  if (runRows.length) {
    const completed = runRows.filter((r) => r.status === 'completed').length
    work.push(`${runRows.length} agent run${runRows.length === 1 ? '' : 's'} (${completed} completed)`)
  }
  if (work.length) lines.push('', `Work: ${work.join('; ')}.`)
  const top = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p]) => p)
  if (top.length) lines.push('', 'Most-changed files:', ...top.map((p) => `- ${p}`))
  for (const kind of ['decision', 'convention', 'learning'] as const) {
    const titles = notes.filter((n) => n.kind === kind).map((n) => n.title)
    if (titles.length) lines.push('', `${kind === 'decision' ? 'Decisions' : kind === 'convention' ? 'Conventions' : 'Learnings'}:`, ...titles.map((t) => `- ${t}`))
  }

  const values = { title: `${story.key}: ${clip(story.title, 150)} — delivered`, content: lines.join('\n') }
  const rows = await tx
    .insert(memoryItems)
    .values({
      ...values,
      orgId: target.orgId,
      projectId: target.projectId,
      storyId: target.storyId,
      createdBy: target.userId,
      scope: 'project',
      kind: 'summary',
      status: 'proposed',
      source: 'story_done',
      sourceRef: `story_done:${target.storyId}`,
    })
    .onConflictDoUpdate({
      target: [memoryItems.projectId, memoryItems.source, memoryItems.sourceRef],
      targetWhere: sql`${memoryItems.sourceRef} is not null`,
      set: { ...values, updatedAt: new Date() },
      setWhere: sql`${memoryItems.status} = 'proposed'`,
    })
    .returning({ id: memoryItems.id })
  return rows.length > 0
}
