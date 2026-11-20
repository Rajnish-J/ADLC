// Memory a harness leaves as files. Not every harness can call `sdlc_add_memory` (a files-tier harness has no SDLC
// tools at all), so the run's session folder has a `memory-out/` outbox: an agent writes one markdown note per thing
// worth keeping, and VS Code posts each to the platform — story memory, or proposed project knowledge for a quick
// fix — linked to the run and step, then moves it to `memory-out/sent/`. Parsing is pure, so it is unit-tested.

import { MEMORY_KINDS, type MemoryKind } from '@sdlc/contracts'

/** The outbox folder inside a run's session folder. */
export const MEMORY_OUT_DIR = 'memory-out'

export interface MemoryNote {
  kind: MemoryKind
  title: string
  content: string
}

const MAX_TITLE = 200
const MAX_CONTENT = 20_000

/** How the outbox is described to an agent (files-tier checkpoints and the session's ORCHESTRATOR file). */
export function memoryOutboxHint(sessionDir: string): string {
  return (
    `To record a decision, convention or learning worth keeping, write a markdown note to \`${sessionDir}/${MEMORY_OUT_DIR}/<short-name>.md\` ` +
    '— a `# Title` line, an optional `kind: decision` (or convention, learning, note) line, then the note. It is saved to the platform for you.'
  )
}

const kindOf = (v: string | undefined): MemoryKind => {
  const k = (v ?? '').trim().toLowerCase() as MemoryKind
  return MEMORY_KINDS.includes(k) ? k : 'note'
}

/**
 * A note from the outbox: YAML-ish front matter (`kind:`, `title:`) or a leading `kind:` line, a `# Title` heading
 * (else the file name), then the body. Undefined when there is nothing to save.
 */
export function parseMemoryNote(text: string, fileName: string): MemoryNote | undefined {
  let body = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const meta: Record<string, string> = {}
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  if (front) {
    for (const line of front[1].split('\n')) {
      const m = /^\s*(\w+)\s*:\s*(.*)$/.exec(line)
      if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '')
    }
    body = body.slice(front[0].length)
  }
  body = body.trim()
  const heading = /^#\s+(.+)$/m.exec(body)
  if (!meta.title && heading && body.startsWith(heading[0])) {
    meta.title = heading[1].trim()
    body = body.slice(heading[0].length).trim()
  }
  const kindLine = /^kind\s*:\s*(\w+)\s*$/im.exec(body.split('\n')[0] ?? '')
  if (kindLine) {
    meta.kind ??= kindLine[1]
    body = body.split('\n').slice(1).join('\n').trim()
  }
  if (!body) return undefined
  const fallback = fileName.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim() || 'Note from the run'
  return {
    kind: kindOf(meta.kind),
    title: (meta.title || fallback).slice(0, MAX_TITLE),
    content: body.slice(0, MAX_CONTENT),
  }
}
