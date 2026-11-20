// Phase 4 (LangGraph) — a durable checkpoint saver so a paused (awaiting-approval) run survives a VS Code
// reload. Subclasses MemorySaver (reusing its correct checkpoint/delta-channel/serde logic verbatim) and
// mirrors its in-memory `storage`/`writes` maps to a JSON file via `vscode.workspace.fs` after every write —
// the same persistence style RunAuditStore already uses. This avoids the native-module bundling risk of
// @langchain/langgraph-checkpoint-sqlite (better-sqlite3 does not esbuild-bundle for the extension host).

import * as vscode from 'vscode'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import type { RunnableConfig } from '@langchain/core/runnables'
import type { Checkpoint, CheckpointListOptions, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint'

const U8_MARKER = '__u8__'

// MemorySaver's storage/writes maps hold serialized checkpoint bytes as Uint8Array several levels deep.
// JSON.stringify can't round-trip Uint8Array on its own, so walk the tree and base64-encode/decode them.
function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [U8_MARKER]: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = encode(v)
    return out
  }
  return value
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj[U8_MARKER] === 'string') return new Uint8Array(Buffer.from(obj[U8_MARKER] as string, 'base64'))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = decode(v)
    return out
  }
  return value
}

const DIR = 'runs'
const FILE = 'langgraph-checkpoints.json'

export class FileBackedCheckpointSaver extends MemorySaver {
  private readonly dir: vscode.Uri
  private readonly file: vscode.Uri
  private loaded: Promise<void> | undefined
  private dirty = false
  private flushing: Promise<void> | undefined

  constructor(globalStorageUri: vscode.Uri) {
    super()
    this.dir = vscode.Uri.joinPath(globalStorageUri, DIR)
    this.file = vscode.Uri.joinPath(this.dir, FILE)
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const bytes = await vscode.workspace.fs.readFile(this.file)
          const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
            storage?: unknown
            writes?: unknown
          }
          if (parsed.storage) this.storage = decode(parsed.storage) as typeof this.storage
          if (parsed.writes) this.writes = decode(parsed.writes) as typeof this.writes
        } catch {
          // No snapshot yet (first run) or unreadable — start empty, same as a fresh MemorySaver.
        }
      })()
    }
    return this.loaded
  }

  // Persistence is coalesced and not awaited by callers: a burst of put()/putWrites() calls marks the maps
  // dirty and a single in-flight flusher loops until clean, so N updates cost one or two whole-file writes
  // (each write re-serializes every thread, so queueing one per call grew quadratically with run size). A
  // crash between a put() and its flush completing loses at most the very latest checkpoint write, an
  // acceptable trade-off for this durability upgrade.
  private persist(): void {
    this.dirty = true
    if (this.flushing) return
    this.flushing = (async () => {
      try {
        while (this.dirty) {
          this.dirty = false
          const body = JSON.stringify({ storage: encode(this.storage), writes: encode(this.writes) })
          await vscode.workspace.fs.createDirectory(this.dir)
          await vscode.workspace.fs.writeFile(this.file, Buffer.from(body, 'utf8'))
        }
      } finally {
        this.flushing = undefined
      }
    })()
  }

  /** Resolves once every pending write has reached disk (used by tests and on deactivate). */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing
  }

  /**
   * Deletes every checkpoint thread whose id is not in `keep`. Called once at restore time with the ids of
   * the runs that still have run metadata, so threads orphaned by a cancel/terminal cleanup that raced a
   * still-finishing node (or by a crash) don't accumulate forever. Returns how many threads were removed.
   */
  async pruneOrphans(keep: ReadonlySet<string>): Promise<number> {
    await this.ensureLoaded()
    const orphans = Object.keys(this.storage).filter((threadId) => !keep.has(threadId))
    for (const threadId of orphans) await this.deleteThread(threadId)
    return orphans.length
  }

  override async getTuple(config: RunnableConfig) {
    await this.ensureLoaded()
    return super.getTuple(config)
  }

  override async *list(config: RunnableConfig, options?: CheckpointListOptions) {
    await this.ensureLoaded()
    yield* super.list(config, options)
  }

  override async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    await this.ensureLoaded()
    const result = await super.put(config, checkpoint, metadata)
    this.persist()
    return result
  }

  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    await this.ensureLoaded()
    await super.putWrites(config, writes, taskId)
    this.persist()
  }

  override async deleteThread(threadId: string): Promise<void> {
    await this.ensureLoaded()
    await super.deleteThread(threadId)
    this.persist()
  }
}
