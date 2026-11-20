// The AI summary on a run's page: what the run changed and why it matters (areas, risks, follow-ups), and — for a
// failed or cancelled run — why it likely failed and what to try next. Written by the chat's Azure OpenAI deployment
// from the run's own record (steps, gates, changes, memory), cached per run, and marked stale when that record
// changes. When no model is configured the page says so instead.

import { createHash } from 'node:crypto'
import { generateText } from 'ai'
import { eq } from 'drizzle-orm'
import { RUN_KIND_LABELS, type ProjectRunDetail, type RunInsight } from '@sdlc/contracts'
import { classifyRunImpact, IMPACT_CATEGORY_LABELS } from '@sdlc/core'
import type { AuthUser } from '../auth'
import { createChatRuntime, type ChatRuntime } from '../chat/llm'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { runInsights } from '../db/schema'
import { conflict } from '../http'

const ENDED = new Set(['completed', 'failed', 'cancelled', 'expired'])
const FAILED = new Set(['failed', 'cancelled', 'expired'])
const PROMPT_VERSION = 'v1'

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text)

/** The run's record as the model reads it. Deterministic, so its hash says when the summary is out of date. */
export function insightInput(detail: ProjectRunDetail): string {
  const lines: string[] = []
  const subject = detail.story ? `${detail.story.key} — ${detail.story.title}` : 'Quick fix (no story)'
  lines.push(`# Agent run: ${RUN_KIND_LABELS[detail.kind]}`, `Work item: ${subject}`)
  if (detail.task) lines.push(`Task: ${detail.task.key} — ${detail.task.title}`)
  if (detail.prompt) lines.push(`Prompt: ${clip(detail.prompt, 1_500)}`)
  lines.push(`Workflow: ${detail.workflowName}`, `Harness: ${detail.engine ?? 'built-in'}`, `Status: ${detail.status}`)
  if (detail.error) lines.push(`Error: ${clip(detail.error, 1_000)}`)
  if (detail.attempt) lines.push(`Attempt ${detail.attempt.number} of ${detail.attempt.total} at this work item`)

  lines.push('', '## Steps')
  for (const s of detail.steps) {
    const who = s.agentName ? ` (${s.agentName})` : ''
    lines.push(`- [${s.status}] ${s.kind}: ${s.label}${who}`)
    if (s.kind === 'gate' && s.gatePass !== null) lines.push(`  Gate ${s.gatePass ? 'passed' : 'failed'}: ${clip(s.gateReason ?? '', 400)}`)
    if (s.approval) lines.push(`  Plan ${s.approval.approve ? 'approved' : 'rejected'}${s.approval.comment ? `: ${clip(s.approval.comment, 300)}` : ''}`)
    if (s.output) lines.push(`  Output: ${clip(s.output.replace(/\s+/g, ' '), 1_200)}`)
    if (s.error) lines.push(`  Error: ${clip(s.error, 400)}`)
  }

  const files = detail.changes?.files ?? []
  const impact = classifyRunImpact(files)
  lines.push('', '## Changes')
  if (!files.length) lines.push(detail.changedFiles.length ? `Files (no line counts): ${detail.changedFiles.slice(0, 60).join(', ')}` : 'No file changes were reported.')
  else {
    lines.push(`${impact.files} files, +${impact.additions} −${impact.deletions} lines (size ${impact.size}).`)
    lines.push(`Areas: ${impact.areas.slice(0, 8).map((a) => `${a.area} (+${a.additions} −${a.deletions})`).join('; ')}`)
    lines.push(`Kinds: ${impact.categories.map((c) => `${IMPACT_CATEGORY_LABELS[c.category]} ${c.files}`).join(', ')}`)
    for (const r of impact.risks) lines.push(`Flag [${r.severity}] ${r.label}: ${r.detail} e.g. ${r.files.slice(0, 5).join(', ')}`)
    lines.push('Files:')
    for (const f of files.slice(0, 60)) lines.push(`- ${f.path} [${f.status}] +${f.additions} −${f.deletions}`)
    if (files.length > 60) lines.push(`- … and ${files.length - 60} more`)
    if (detail.changes?.commits.length) lines.push(`Commits: ${detail.changes.commits.slice(0, 10).map((c) => clip(c.message.split('\n')[0], 100)).join(' | ')}`)
  }

  lines.push('', '## Memory')
  lines.push(`Given ${detail.memory.used.length} memory item(s)${detail.memory.used.length ? `: ${detail.memory.used.slice(0, 10).map((m) => m.title).join('; ')}` : ''}.`)
  lines.push(`Wrote ${detail.memory.written.length} item(s)${detail.memory.written.length ? `: ${detail.memory.written.map((m) => m.title).join('; ')}` : ''}.`)
  return lines.join('\n')
}

export function insightHash(input: string): string {
  return createHash('sha256').update(`${PROMPT_VERSION}\n${input}`).digest('hex')
}

const SYSTEM = `You review AI coding-agent runs on a software project for the developer or lead who decides what to do with the result.
Use only the run record you are given: never invent files, changes or results. Name files and areas. Be concise and concrete.
Answer in Markdown with exactly the sections asked for and nothing before the first heading.`

function instructions(failed: boolean): string {
  return [
    'Write:',
    '## Impact',
    'At most 180 words: what the run changed and where, what that means for the project, the risks a reviewer should check first (use the flags), and any follow-up work.',
    ...(failed
      ? ['', '## Why it failed', 'At most 120 words: the most likely cause, from the error, failed gate, rejected plan or step outputs, and 2–3 concrete things to try next.']
      : []),
  ].join('\n')
}

/** Split the model's answer into the impact and failure sections. Pure — unit-tested. */
export function parseInsight(text: string): { impact: string; failure: string | null } {
  const body = text.trim()
  const split = body.split(/^#{1,3}\s*Why it failed\s*$/im)
  const impact = split[0].replace(/^#{1,3}\s*Impact\s*$/im, '').trim()
  const failure = split.length > 1 ? split.slice(1).join('\n').trim() || null : null
  return { impact, failure }
}

export interface RunInsightsService {
  status(db: Db, detail: ProjectRunDetail): Promise<RunInsight>
  generate(db: Db, user: AuthUser, detail: ProjectRunDetail, force: boolean): Promise<RunInsight>
}

export function createRunInsights(config: Config, runtime: ChatRuntime = createChatRuntime(config)): RunInsightsService {
  const enabled = runtime.config.enabled
  const reason = runtime.config.reason

  async function status(db: Db, detail: ProjectRunDetail): Promise<RunInsight> {
    const [row] = await db.select().from(runInsights).where(eq(runInsights.runId, detail.id)).limit(1)
    return {
      enabled,
      reason: enabled ? (ENDED.has(detail.status) ? null : 'The summary is written once the run ends.') : reason,
      impact: row?.impactMd ?? null,
      failure: row?.failureMd ?? null,
      model: row?.model ?? null,
      generatedAt: row?.generatedAt.toISOString() ?? null,
      stale: row ? row.inputHash !== insightHash(insightInput(detail)) : false,
    }
  }

  async function generate(db: Db, user: AuthUser, detail: ProjectRunDetail, force: boolean): Promise<RunInsight> {
    if (!enabled) return status(db, detail)
    if (!ENDED.has(detail.status)) throw conflict('The run is still going; its summary is written once it ends.')
    const input = insightInput(detail)
    const hash = insightHash(input)
    const [existing] = await db.select({ hash: runInsights.inputHash }).from(runInsights).where(eq(runInsights.runId, detail.id)).limit(1)
    if (existing && existing.hash === hash && !force) return status(db, detail)

    const { model, info } = runtime.model(null)
    const failed = FAILED.has(detail.status)
    const result = await generateText({
      model,
      system: SYSTEM,
      prompt: `${input}\n\n---\n${instructions(failed)}`,
      maxOutputTokens: 2_500,
      abortSignal: AbortSignal.timeout(90_000),
    })
    const { impact, failure } = parseInsight(result.text)
    const values = { impactMd: impact || null, failureMd: failed ? failure : null, model: info.label, inputHash: hash, generatedBy: user.id, generatedAt: new Date() }
    await db
      .insert(runInsights)
      .values({ runId: detail.id, ...values })
      .onConflictDoUpdate({ target: runInsights.runId, set: values })
    return status(db, detail)
  }

  return { status, generate }
}
