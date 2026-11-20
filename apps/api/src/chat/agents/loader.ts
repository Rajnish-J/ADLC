// The chat's assistants: one markdown file each in ./definitions — YAML front matter (name, label, icon,
// description, scope, draft, tools, maxSteps, order, placeholder) and the system prompt as the body. Read once at
// startup and validated: an unknown tool name or bad field fails loudly instead of silently dropping a tool.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import { DRAFT_KINDS, type ChatAgentSummary } from '@sdlc/contracts'
import { KNOWN_TOOL_NAMES } from '../tools'

export const DEFAULT_AGENT = 'default'
export const DEFINITIONS_DIR = path.join(__dirname, 'definitions')

const FrontMatterSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1).max(40),
  icon: z.string().min(1).max(40),
  description: z.string().min(1).max(300),
  scope: z.enum(['project', 'org']),
  draft: z.enum(DRAFT_KINDS).nullable().default(null),
  placeholder: z.string().max(120).default('Ask anything…'),
  tools: z.array(z.string()).min(1),
  maxSteps: z.number().int().min(1).max(50).default(10),
  order: z.number().int().default(100),
})

export interface ChatAgentDef extends ChatAgentSummary {
  tools: string[]
  maxSteps: number
  order: number
  /** The markdown body: this assistant's own instructions. */
  prompt: string
}

export function parseAgentFile(file: string, text: string): ChatAgentDef {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${file}: missing YAML front matter`)
  const parsed = FrontMatterSchema.safeParse(yaml.load(match[1]))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`${file}: ${issue?.path.join('.') || 'front matter'} — ${issue?.message}`)
  }
  const fm = parsed.data
  if (`${fm.name}.md` !== path.basename(file)) throw new Error(`${file}: name "${fm.name}" must match the file name`)
  const unknown = fm.tools.filter((t) => !KNOWN_TOOL_NAMES.has(t))
  if (unknown.length) throw new Error(`${file}: unknown tool(s) ${unknown.join(', ')}`)
  if (fm.tools.includes('update_draft') && !fm.draft) throw new Error(`${file}: update_draft needs a \`draft\` kind`)
  return {
    name: fm.name,
    label: fm.label,
    icon: fm.icon,
    description: fm.description.trim(),
    scope: fm.scope,
    draft: fm.draft,
    placeholder: fm.placeholder,
    tools: fm.tools,
    maxSteps: fm.maxSteps,
    order: fm.order,
    prompt: match[2].trim(),
  }
}

export function loadAgents(dir: string = DEFINITIONS_DIR): ChatAgentDef[] {
  const defs = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => parseAgentFile(f, readFileSync(path.join(dir, f), 'utf8')))
  if (!defs.some((d) => d.name === DEFAULT_AGENT)) throw new Error(`chat agents: ${DEFAULT_AGENT}.md is required`)
  return defs.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
}

export const toAgentSummary = (d: ChatAgentDef): ChatAgentSummary => ({
  name: d.name,
  label: d.label,
  icon: d.icon,
  description: d.description,
  scope: d.scope,
  draft: d.draft,
  placeholder: d.placeholder,
})
