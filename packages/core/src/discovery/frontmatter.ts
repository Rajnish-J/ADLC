// YAML frontmatter splitter — used by the markdown-based adapters.
//
// Many conventions wrap a YAML metadata block in `---` fences at the top of a
// markdown/mdc file, followed by a free-form body. This splits the two and parses
// the metadata with js-yaml (robust: handles arrays / nested fields a flat
// key:value parser would mangle). Parsing NEVER executes anything.

import * as yaml from 'js-yaml'

export interface Frontmatter {
  /** Parsed YAML metadata ({} when there is no frontmatter block). */
  meta: Record<string, unknown>
  /** Everything after the closing fence (or the whole file when no fence). */
  body: string
  /** True when a `---` block was present but failed to parse as YAML. */
  malformed: boolean
}

const FENCE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/

/**
 * Split leading `---` YAML frontmatter from the body. Tolerant: a missing or
 * malformed block yields `meta: {}` and flags `malformed` rather than throwing.
 */
export function splitFrontmatter(content: string): Frontmatter {
  const normalized = content.replace(/^﻿/, '') // strip BOM
  const match = FENCE.exec(normalized)
  if (!match) {
    return { meta: {}, body: normalized.trim(), malformed: false }
  }

  const [, block] = match
  const body = normalized.slice(match[0].length).trim()

  try {
    const parsed = yaml.load(block)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { meta: parsed as Record<string, unknown>, body, malformed: false }
    }
    // A scalar/array where we expected a mapping → treat as malformed metadata.
    return { meta: {}, body, malformed: true }
  } catch {
    return { meta: {}, body, malformed: true }
  }
}

/** Parse a whole-file YAML document (agent.yaml). Returns null on parse error. */
export function parseYamlDocument(content: string): Record<string, unknown> | null {
  try {
    const parsed = yaml.load(content.replace(/^﻿/, ''))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** Best-effort: coerce an unknown YAML value to a trimmed string. */
export function asString(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value.trim()
  }
  return String(value).trim()
}
