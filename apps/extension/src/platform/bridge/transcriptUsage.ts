// Token usage from a harness's own transcript. Claude Code's hooks carry `transcript_path` (a JSONL file, one entry
// per line); its assistant entries hold the API usage. Reading only what was appended since the last read gives the
// tokens spent since then, which the run attributes to the step being worked on — the Agent map and the step
// records show it. Entries before the run started are ignored (a reused chat session has older turns).

import { open } from 'fs/promises'

export interface TokenUsage {
  tokensIn: number
  tokensOut: number
}

const ZERO: TokenUsage = { tokensIn: 0, tokensOut: 0 }

type Json = Record<string, unknown>
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * The usage the given transcript lines add. One API message is written as several entries (one per content
 * block), each repeating the message's usage: `seen` keeps the last usage per message id so only growth counts.
 */
export function usageFromLines(lines: readonly string[], since: number, seen: Map<string, TokenUsage>): TokenUsage {
  let tokensIn = 0
  let tokensOut = 0
  for (const line of lines) {
    if (!line.includes('"usage"')) continue
    let entry: Json
    try {
      entry = JSON.parse(line) as Json
    } catch {
      continue
    }
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    if (Number.isFinite(at) && at < since) continue
    const message = (entry.message ?? {}) as Json
    const usage = (message.usage ?? {}) as Json
    const now: TokenUsage = {
      tokensIn: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
      tokensOut: num(usage.output_tokens),
    }
    if (now.tokensIn === 0 && now.tokensOut === 0) continue
    const id = typeof message.id === 'string' ? message.id : typeof entry.uuid === 'string' ? entry.uuid : undefined
    const before = id ? (seen.get(id) ?? ZERO) : ZERO
    const add = { tokensIn: Math.max(0, now.tokensIn - before.tokensIn), tokensOut: Math.max(0, now.tokensOut - before.tokensOut) }
    if (id) seen.set(id, { tokensIn: Math.max(before.tokensIn, now.tokensIn), tokensOut: Math.max(before.tokensOut, now.tokensOut) })
    tokensIn += add.tokensIn
    tokensOut += add.tokensOut
  }
  return { tokensIn, tokensOut }
}

/** Largest chunk read from a transcript at once (a long session's first read). */
const MAX_READ = 8 * 1024 * 1024

/** Reads transcripts incrementally for one run. */
export class TranscriptUsage {
  private readonly files = new Map<string, { offset: number; rest: string; seen: Map<string, TokenUsage> }>()

  /** @param since the run's start (ms): earlier entries are someone else's. */
  constructor(private readonly since: number) {}

  /** The tokens added to the transcript since the last read of it (zero when it can't be read). */
  async read(path: string): Promise<TokenUsage> {
    const state = this.files.get(path) ?? { offset: 0, rest: '', seen: new Map<string, TokenUsage>() }
    this.files.set(path, state)
    let text = ''
    try {
      const fh = await open(path, 'r')
      try {
        const { size } = await fh.stat()
        if (size < state.offset) Object.assign(state, { offset: 0, rest: '' }) // rewritten (compacted): start over
        const length = Math.min(MAX_READ, size - state.offset)
        if (length <= 0) return ZERO
        const buf = Buffer.alloc(length)
        const { bytesRead } = await fh.read(buf, 0, length, state.offset)
        state.offset += bytesRead
        text = buf.subarray(0, bytesRead).toString('utf8')
      } finally {
        await fh.close()
      }
    } catch {
      return ZERO
    }
    const lines = (state.rest + text).split('\n')
    state.rest = lines.pop() ?? '' // a line still being written
    return usageFromLines(lines, this.since, state.seen)
  }
}
