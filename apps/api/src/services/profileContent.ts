// Pure parts of the project profile (unit-tested): the schema the model fills, the deterministic profile built from
// the repository alone (no AI model, or the model failed to answer), the input for an update after runs, and the
// compact version agents get in their memory context.

import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  PROFILE_MATURITIES,
  PROFILE_SECTION_KEYS,
  PROFILE_SECTION_LABELS,
  type ProfileChange,
  type ProfileContent,
  type ProfileMaturity,
  type ProfileSections,
  type ProfileStack,
} from '@sdlc/contracts'
import { classifyRunImpact, envVarNames, IMPACT_CATEGORY_LABELS, type ProfileEvidence } from '@sdlc/core'

export const PROFILE_PROMPT_VERSION = 'v1'

// ─── What the model returns ──────────────────────────────────────────────────────────────────────
// No length limits or optional fields: strict structured output accepts neither. Clamped after parsing.

const ModelSection = z.object({
  markdown: z.string().describe('Markdown body of the section, without a heading.'),
  sources: z.array(z.string()).describe('Repository paths the section relied on, most important first (max 10).'),
})

export const ModelProfileSchema = z.object({
  headline: z.string().describe('One sentence: what the project is and who it is for.'),
  maturity: z.enum(PROFILE_MATURITIES),
  sections: z.object({
    overview: ModelSection,
    techStack: ModelSection,
    architecture: ModelSection,
    status: ModelSection,
    developerGuide: ModelSection,
    integrations: ModelSection,
  }),
  changes: z
    .array(z.object({ runId: z.string(), summary: z.string() }))
    .describe('Update mode only: one line per run folded in (what it changed). Empty when generating.'),
})
export type ModelProfile = z.infer<typeof ModelProfileSchema>

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text)

/** Clamp what the model wrote to what the contract allows. */
export function clampSections(sections: ModelProfile['sections']): ProfileSections {
  const out = {} as ProfileSections
  for (const key of PROFILE_SECTION_KEYS) {
    const s = sections[key]
    out[key] = { markdown: clip(s.markdown.trim(), 12_000), sources: [...new Set(s.sources.map((p) => p.trim()).filter(Boolean))].slice(0, 10).map((p) => clip(p, 500)) }
  }
  return out
}

// ─── Platform facts ──────────────────────────────────────────────────────────────────────────────

export interface PlatformFacts {
  projectName: string
  projectKey: string
  description: string
  branch: string
  commit: { sha: string | null; message: string | null; author: string | null; at: string | null }
  stories: Record<string, number>
  recentRuns: Array<{ workflow: string; status: string; story: string | null; finishedAt: string | null }>
  /** completed / (completed + failed) over recent runs, in %; null when none ended. */
  successRate: number | null
}

export function renderFacts(f: PlatformFacts): string {
  const lines = ['## Platform facts', `Project: ${f.projectName} (${f.projectKey})`]
  if (f.description) lines.push(`Description on the platform: ${clip(f.description, 600)}`)
  lines.push(`Branch read: ${f.branch}${f.commit.sha ? ` @ ${f.commit.sha.slice(0, 7)}` : ''}`)
  if (f.commit.message) lines.push(`Last commit: "${clip(f.commit.message.split('\n')[0], 140)}"${f.commit.author ? ` by ${f.commit.author}` : ''}${f.commit.at ? ` on ${f.commit.at.slice(0, 10)}` : ''}`)
  const stories = Object.entries(f.stories).filter(([, n]) => n > 0)
  lines.push(`Stories by status: ${stories.length ? stories.map(([s, n]) => `${s} ${n}`).join(', ') : 'none yet'}`)
  lines.push(`Agent runs: ${f.recentRuns.length ? `${f.recentRuns.length} recent` : 'none yet'}${f.successRate !== null ? `, success rate ${f.successRate}%` : ''}`)
  for (const r of f.recentRuns) lines.push(`- [${r.status}] ${r.workflow}${r.story ? ` — ${r.story}` : ''}${r.finishedAt ? ` (${r.finishedAt.slice(0, 10)})` : ''}`)
  return lines.join('\n')
}

export function stackOf(e: ProfileEvidence): ProfileStack {
  return { languages: e.languages.slice(0, 12), frameworks: e.frameworks.slice(0, 40), packageManagers: e.packageManagers, modules: e.modules.slice(0, 40) }
}

export function inputHash(text: string): string {
  return createHash('sha256').update(`${PROFILE_PROMPT_VERSION}\n${text}`).digest('hex')
}

// ─── Deterministic profile (no model) ────────────────────────────────────────────────────────────

/** The first prose paragraph(s) of a README, without headings, badges or HTML. */
export function readmeIntro(text: string, max = 900): string {
  const paras = text
    .replace(/<[^>]+>/g, '')
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#') && !p.startsWith('[![') && !p.startsWith('![') && !p.startsWith('```') && !/^[-*|]/.test(p))
  return clip(paras.slice(0, 2).join('\n\n'), max)
}

function guessMaturity(e: ProfileEvidence, f: PlatformFacts): ProfileMaturity {
  const deploys = e.configs.some((c) => /Dockerfile|vercel|netlify|fly\.toml|render\.yaml|app\.yaml|serverless|\.tf$|\.bicep$|Chart\.yaml/i.test(c)) || e.frameworks.includes('Docker')
  if (e.tests.files >= 20 && e.ci.length && deploys) return 'stable'
  if (e.tests.files > 0 || e.ci.length || f.recentRuns.length) return 'active'
  return 'prototype'
}

const list = (items: string[], empty: string) => (items.length ? items.map((i) => `- ${i}`).join('\n') : empty)

export function deterministicProfile(e: ProfileEvidence, f: PlatformFacts): { headline: string; maturity: ProfileMaturity; sections: ProfileSections } {
  const readme = e.docs.find((d) => /(^|\/)readme/i.test(d.path) && !d.path.includes('/'))
  const rootManifest = e.nodeManifests.find((m) => !m.path.includes('/'))
  const intro = readme ? readmeIntro(readme.content) : ''
  const lang = e.languages[0]?.name
  const headline =
    rootManifest?.description || f.description || intro.split(/(?<=\.)\s/)[0] || `${f.projectName} — a ${lang ?? 'software'} project${e.frameworks.length ? ` built with ${e.frameworks.slice(0, 3).join(', ')}` : ''}.`

  const scripts = e.nodeManifests.flatMap((m) => {
    const dir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : '.'
    return Object.entries(m.scripts)
      .filter(([k]) => /^(dev|start|build|test|lint|typecheck|format|e2e|db:[a-z]+|migrate|seed)$/.test(k))
      .map(([k, v]) => `\`${dir === '.' ? `npm run ${k}` : `npm run ${k} -w ${m.name ?? dir}`}\` — ${clip(v, 100)}`)
  })
  const envs = e.envExamples.map((d) => `${d.path}: ${envVarNames(d.content).map((n) => `\`${n}\``).join(', ') || '(none)'}`)
  const engines = e.nodeManifests.flatMap((m) => Object.entries(m.engines).map(([k, v]) => `${k} ${v}`))

  const sections: ProfileSections = {
    overview: {
      markdown: [intro || rootManifest?.description || f.description || '_No README or description found in the repository._'].join('\n\n'),
      sources: readme ? [readme.path] : [],
    },
    techStack: {
      markdown: [
        `**Languages:** ${e.languages.slice(0, 8).map((l) => `${l.name} (${l.percent}%)`).join(', ') || 'none detected'}`,
        `**Frameworks and libraries:** ${e.frameworks.join(', ') || 'none detected'}`,
        `**Package managers:** ${e.packageManagers.join(', ') || 'none detected'}`,
        ...(engines.length ? [`**Runtime versions:** ${[...new Set(engines)].join(', ')}`] : []),
      ].join('\n\n'),
      sources: [...e.nodeManifests.map((m) => m.path), ...e.manifests.map((m) => m.path)].slice(0, 10),
    },
    architecture: {
      markdown: [
        e.modules.length ? `**Modules**\n${list(e.modules.map((m) => `\`${m.path}\` — ${m.name} (${m.kind})`), '')}` : '',
        `**Folder layout**\n\`\`\`\n${e.tree.slice(0, 40).join('\n')}\n\`\`\``,
      ]
        .filter(Boolean)
        .join('\n\n'),
      sources: e.modules.map((m) => m.path).slice(0, 10),
    },
    status: {
      markdown: [
        `**Stories:** ${Object.entries(f.stories).filter(([, n]) => n > 0).map(([s, n]) => `${s.replace('_', ' ')} ${n}`).join(', ') || 'none yet'}`,
        `**Agent runs:** ${f.recentRuns.length} recent${f.successRate !== null ? `, ${f.successRate}% succeeded` : ''}`,
        f.commit.message ? `**Last commit on \`${f.branch}\`:** ${clip(f.commit.message.split('\n')[0], 140)}${f.commit.at ? ` (${f.commit.at.slice(0, 10)})` : ''}` : '',
        `**Tests:** ${e.tests.files} test files${e.tests.frameworks.length ? ` (${e.tests.frameworks.join(', ')})` : ''}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      sources: [],
    },
    developerGuide: {
      markdown: [
        `**Commands**\n${list(scripts.slice(0, 25), '_No scripts found._')}`,
        `**Environment variables**\n${list(envs, '_No example environment files found._')}`,
        e.configs.length ? `**Tooling config:** ${e.configs.filter((c) => /eslint|prettier|biome|ruff|tsconfig|vitest|jest|playwright|pytest|mypy/i.test(c)).map((c) => `\`${c}\``).join(', ') || '—'}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      sources: [...e.envExamples.map((d) => d.path), ...e.nodeManifests.map((m) => m.path)].slice(0, 10),
    },
    integrations: {
      markdown: [
        `**CI pipelines:** ${e.ci.map((c) => `\`${c.path}\``).join(', ') || 'none found'}`,
        `**Infrastructure and deploy config:** ${e.configs.filter((c) => /Dockerfile|compose|vercel|netlify|fly|render|app\.yaml|serverless|\.tf$|\.bicep$|Chart|k8s|kubernetes|Procfile/i.test(c)).map((c) => `\`${c}\``).join(', ') || 'none found'}`,
        `**Tests:** ${e.tests.files ? `${e.tests.files} files in ${e.tests.folders.join(', ') || 'the source tree'}` : 'none found'}`,
      ].join('\n\n'),
      sources: e.ci.map((c) => c.path).slice(0, 10),
    },
  }
  return { headline: clip(headline.trim(), 400), maturity: guessMaturity(e, f), sections }
}

// ─── Project memory the profiler reads ───────────────────────────────────────────────────────────

export interface MemoryForProfile {
  kind: string
  title: string
  content: string
  pinned: boolean
  updatedAt: string
}

const KIND_ORDER: Record<string, number> = { convention: 0, decision: 1, learning: 2, note: 3, summary: 4 }
const KIND_LABEL: Record<string, string> = { convention: 'Convention', decision: 'Decision', learning: 'Learning', note: 'Note', summary: 'Summary' }

/**
 * Accepted project memory as the profiler reads it: pinned items first, then conventions, decisions, learnings,
 * notes and the newest summaries; each clipped, the whole within `budget`. Deterministic (part of the input hash).
 */
export function renderMemoryForProfile(items: MemoryForProfile[], budget = 8_000, perItem = 600): string {
  if (!items.length) return ''
  const sorted = [...items].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || b.updatedAt.localeCompare(a.updatedAt),
  )
  const header = '## Project memory (accepted by the team)'
  const lines = [header]
  let used = header.length
  let shown = 0
  for (const m of sorted) {
    const body = clip(m.content.trim().replace(/\s+\n/g, '\n'), perItem)
    const entry = `- **${KIND_LABEL[m.kind] ?? m.kind}${m.pinned ? ' (pinned)' : ''}: ${m.title}**${body ? `\n  ${body.replace(/\n/g, '\n  ')}` : ''}`
    if (used + entry.length + 1 > budget) {
      lines.push(`- … ${sorted.length - shown} more item(s) not shown`)
      break
    }
    lines.push(entry)
    used += entry.length + 1
    shown += 1
  }
  return lines.join('\n')
}

// ─── Updating after runs ─────────────────────────────────────────────────────────────────────────

export interface RunForProfile {
  id: string
  workflowName: string
  story: string | null
  prompt: string | null
  finishedAt: string | null
  branch: string | null
  files: Array<{ path: string; status: string; additions: number; deletions: number; binary?: boolean }>
  changedFiles: string[]
  patch: string | null
  summary: string | null
}

/** What the model reads to fold runs into the profile. Deterministic. */
export function renderRunsForUpdate(runs: RunForProfile[], patchBudget = 15_000): string {
  const lines = ['## Runs completed since the profile was accepted']
  const perRunPatch = Math.max(1_500, Math.floor(patchBudget / Math.max(1, runs.length)))
  for (const r of runs) {
    lines.push('', `### Run ${r.id}`, `Workflow: ${r.workflowName}`, `Work item: ${r.story ?? 'Quick fix (no story)'}`)
    if (r.branch) lines.push(`Branch: ${r.branch}`)
    if (r.finishedAt) lines.push(`Finished: ${r.finishedAt.slice(0, 16).replace('T', ' ')}`)
    if (r.prompt) lines.push(`Prompt: ${clip(r.prompt, 800)}`)
    if (r.summary) lines.push(`Agent summary: ${clip(r.summary.replace(/\s+/g, ' '), 1_200)}`)
    if (r.files.length) {
      const impact = classifyRunImpact(r.files)
      lines.push(`Changes: ${impact.files} files, +${impact.additions} −${impact.deletions}; kinds ${impact.categories.map((c) => `${IMPACT_CATEGORY_LABELS[c.category]} ${c.files}`).join(', ')}`)
      for (const f of r.files.slice(0, 50)) lines.push(`- ${f.path} [${f.status}] +${f.additions} −${f.deletions}`)
      if (r.files.length > 50) lines.push(`- … and ${r.files.length - 50} more`)
    } else if (r.changedFiles.length) {
      lines.push(`Files: ${r.changedFiles.slice(0, 50).join(', ')}`)
    }
    if (r.patch) lines.push('Patch excerpt:', '```diff', clip(r.patch, perRunPatch), '```')
  }
  return lines.join('\n')
}

/** The current profile, as the model reads it when updating. */
export function renderProfileForUpdate(content: ProfileContent): string {
  const lines = ['## Current profile', `headline: ${content.headline}`, `maturity: ${content.maturity}`]
  for (const key of PROFILE_SECTION_KEYS) {
    lines.push('', `### ${key}`, content.sections[key].markdown, `sources: ${content.sections[key].sources.join(', ') || '(none)'}`)
  }
  return lines.join('\n')
}

/** New changelog entries first, then the previous ones; capped. */
export function mergeChangelog(previous: ProfileChange[], added: ProfileChange[], max = 30): ProfileChange[] {
  const seen = new Set<string>()
  const out: ProfileChange[] = []
  for (const c of [...added, ...previous]) {
    const id = `${c.runId ?? ''}|${c.summary}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(c)
  }
  return out.slice(0, max)
}

// ─── Agent context ───────────────────────────────────────────────────────────────────────────────

/** Section budgets in the compact profile agents get (status and integrations are trimmed hardest). */
const CONTEXT_BUDGET: Record<(typeof PROFILE_SECTION_KEYS)[number], number> = {
  overview: 900,
  techStack: 900,
  architecture: 1_400,
  developerGuide: 1_200,
  integrations: 600,
  status: 400,
}
const CONTEXT_ORDER = ['overview', 'techStack', 'architecture', 'developerGuide', 'integrations', 'status'] as const

/** The accepted profile as agents get it in memory.md: compact, within `maxChars`. */
export function profileContextMarkdown(content: ProfileContent, maxChars = 5_000): string {
  const lines = [`**${content.headline}** (maturity: ${content.maturity})`]
  if (content.stack.languages.length || content.stack.frameworks.length) {
    lines.push(`Stack: ${[...content.stack.languages.slice(0, 5).map((l) => l.name), ...content.stack.frameworks.slice(0, 15)].join(', ')}`)
  }
  for (const key of CONTEXT_ORDER) {
    const body = content.sections[key].markdown.trim()
    if (!body) continue
    lines.push('', `**${PROFILE_SECTION_LABELS[key]}**`, clip(body, CONTEXT_BUDGET[key]))
  }
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text
}
