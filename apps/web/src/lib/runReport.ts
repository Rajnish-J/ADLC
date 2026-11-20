// Reports built from a run's record, in the browser: a pull-request description / Markdown report of one run, and
// the runs table as CSV. Pure — no React.

import { harnessLabel, RUN_KIND_LABELS, RUN_STATUS_LABELS, type ProjectRun, type ProjectRunDetail } from '@sdlc/contracts'
import { classifyRunImpact, IMPACT_CATEGORY_LABELS } from '@sdlc/core'

function duration(from: string, to: string | null): string {
  if (!to) return 'still running'
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** What the run worked on, in one line. */
export function runTitle(run: Pick<ProjectRun, 'story' | 'task' | 'prompt' | 'workflowName'>): string {
  if (run.task) return `${run.task.key} · ${run.task.title}`
  if (run.story) return `${run.story.key}-${run.story.number} · ${run.story.title}`
  const line = run.prompt?.trim().split('\n')[0]
  return line ? `Quick fix: ${line.length > 90 ? `${line.slice(0, 90)}…` : line}` : run.workflowName
}

/**
 * A pull-request description for the run's changes: what it did (the last agent's report), the impact, the files,
 * the gates, and the memory it used and wrote. `insight` is the AI summary when there is one.
 */
export function runReportMarkdown(run: ProjectRunDetail, runUrl?: string): string {
  const files = run.changes?.files ?? []
  const impact = classifyRunImpact(files)
  const lines: string[] = [`## ${runTitle(run)}`, '']
  const facts = [
    `**Run:** ${RUN_KIND_LABELS[run.kind]}${run.attempt ? ` (attempt ${run.attempt.number} of ${run.attempt.total})` : ''} · ${RUN_STATUS_LABELS[run.status]}`,
    `**Workflow:** ${run.workflowName} · **Harness:** ${run.engine ? harnessLabel(run.engine) : 'Built-in'} · **Duration:** ${duration(run.startedAt, run.finishedAt)}`,
    `**Started by:** ${run.startedBy?.displayName ?? 'someone'}${run.changes?.branch ? ` · **Branch:** \`${run.changes.branch}\`` : ''}`,
  ]
  lines.push(...facts.map((f) => `- ${f}`))
  if (run.prompt) lines.push('', '### Prompt', '', run.prompt.trim())

  const summary = [...run.steps].filter((s) => s.kind === 'agent' && s.output?.trim()).sort((a, b) => b.seq - a.seq)[0]
  if (run.insight?.impact) lines.push('', '### Impact', '', run.insight.impact.trim())
  else if (summary?.output) lines.push('', '### What changed', '', summary.output.trim())

  if (files.length) {
    lines.push('', `### Changes (${impact.files} files, +${impact.additions} −${impact.deletions})`, '')
    if (impact.areas.length) lines.push(`Areas: ${impact.areas.slice(0, 6).map((a) => `\`${a.area}\``).join(', ')}`, '')
    if (impact.risks.length) {
      lines.push('Review first:')
      for (const r of impact.risks) lines.push(`- **${r.label}** — ${r.detail}`)
      lines.push('')
    }
    lines.push('| File | Change | + | − |', '|---|---|---:|---:|')
    for (const f of files.slice(0, 50)) lines.push(`| \`${f.path}\` | ${f.status} | ${f.additions} | ${f.deletions} |`)
    if (files.length > 50) lines.push(`| … and ${files.length - 50} more | | | |`)
    lines.push('', `Kinds of files: ${impact.categories.map((c) => `${IMPACT_CATEGORY_LABELS[c.category]} (${c.files})`).join(', ')}`)
  }

  const gates = run.steps.filter((s) => s.kind === 'gate' && s.gatePass !== null)
  if (gates.length) {
    lines.push('', '### Gates', '')
    for (const g of gates) lines.push(`- ${g.gatePass ? '✅' : '❌'} ${g.label}${g.gateReason ? ` — ${g.gateReason}` : ''}`)
  }
  if (run.memory.used.length || run.memory.written.length) {
    lines.push('', '### Memory', '')
    if (run.memory.used.length) lines.push(`- Used: ${run.memory.used.map((m) => m.title).join('; ')}`)
    if (run.memory.written.length) lines.push(`- Wrote: ${run.memory.written.map((m) => `${m.title} (${m.status})`).join('; ')}`)
  }
  if (runUrl) lines.push('', `[Full run record](${runUrl})`)
  return `${lines.join('\n')}\n`
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The runs as CSV, one row per run (spreadsheet-friendly). */
export function runsCsv(runs: ProjectRun[]): string {
  const header = ['Run', 'Kind', 'Attempt', 'Status', 'Workflow', 'Harness', 'Started by', 'Started', 'Finished', 'Files', 'Additions', 'Deletions', 'Memory used', 'Memory written', 'Gates passed', 'Gates failed', 'Thumbs up', 'Thumbs down', 'Branch', 'Run id']
  const rows = runs.map((r) => [
    runTitle(r),
    RUN_KIND_LABELS[r.kind],
    r.iteration,
    RUN_STATUS_LABELS[r.status],
    r.workflowName,
    r.engine ? harnessLabel(r.engine) : 'Built-in',
    r.startedBy?.displayName ?? '',
    r.startedAt,
    r.finishedAt,
    r.filesChanged,
    r.additions,
    r.deletions,
    r.memoryUsed,
    r.memoryWritten,
    r.gatesPassed,
    r.gatesFailed,
    r.feedback.up,
    r.feedback.down,
    r.branch,
    r.id,
  ])
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
}

/** Save text as a file in the browser. */
export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
