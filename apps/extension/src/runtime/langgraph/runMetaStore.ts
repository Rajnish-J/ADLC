// Phase 4 (LangGraph) — persists the small piece of metadata LangGraphWorkflowRuntime needs to recompile a
// run's StateGraph after an extension-host restart (the checkpointer alone durably stores LangGraph's own
// channel state, but recompiling the graph's node functions requires the original WorkflowSpec/budget/actor
// again). Same read-modify-write JSON persistence style as FileBackedCheckpointSaver/RunAuditStore.
//
// Only NON-TERMINAL runs live here: the runtime deletes a run's entry the moment it completes, fails or is
// cancelled (see LangGraphWorkflowRuntime.retire), so the file stays small and `list()` is exactly the set of
// runs worth restoring after a reload.

import * as vscode from 'vscode'
import type { RunMeta } from './runMeta'

export type { RunMeta } from './runMeta'

const DIR = 'runs'
const FILE = 'langgraph-run-meta.json'

export class RunMetaStore {
  private readonly dir: vscode.Uri
  private readonly file: vscode.Uri
  private cache: Record<string, RunMeta> | undefined
  private dirty = false
  private flushing: Promise<void> | undefined

  constructor(globalStorageUri: vscode.Uri) {
    this.dir = vscode.Uri.joinPath(globalStorageUri, DIR)
    this.file = vscode.Uri.joinPath(this.dir, FILE)
  }

  private async ensureLoaded(): Promise<Record<string, RunMeta>> {
    if (!this.cache) {
      try {
        const bytes = await vscode.workspace.fs.readFile(this.file)
        this.cache = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, RunMeta>
      } catch {
        this.cache = {}
      }
    }
    return this.cache
  }

  /**
   * Coalesced write: a burst of save()/delete() calls marks the cache dirty and one in-flight flusher loops
   * until it is clean, so N updates cost one or two file writes rather than N whole-file rewrites queued
   * back to back.
   */
  private schedulePersist(): void {
    this.dirty = true
    if (this.flushing) return
    this.flushing = (async () => {
      try {
        while (this.dirty) {
          this.dirty = false
          await vscode.workspace.fs.createDirectory(this.dir)
          await vscode.workspace.fs.writeFile(this.file, Buffer.from(JSON.stringify(this.cache ?? {}), 'utf8'))
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

  async save(runId: string, meta: RunMeta): Promise<void> {
    const cache = await this.ensureLoaded()
    cache[runId] = meta
    this.schedulePersist()
  }

  async get(runId: string): Promise<RunMeta | undefined> {
    const cache = await this.ensureLoaded()
    return cache[runId]
  }

  async delete(runId: string): Promise<void> {
    const cache = await this.ensureLoaded()
    if (!(runId in cache)) return
    delete cache[runId]
    this.schedulePersist()
  }

  async list(): Promise<Array<{ runId: string; meta: RunMeta }>> {
    const cache = await this.ensureLoaded()
    return Object.entries(cache).map(([runId, meta]) => ({ runId, meta }))
  }
}
