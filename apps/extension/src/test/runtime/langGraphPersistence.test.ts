// Phase 4 (LangGraph) — the parts of restore/cleanup that touch `vscode`: RunService.restore() (and its audit
// de-duplication), the file-backed checkpoint saver, and the run-metadata store. These need the VS Code test
// host (`npm test`); the engine-level behaviour is covered by langGraphLifecycle.test.ts, which also runs
// under plain mocha.

import * as assert from 'assert'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { FileBackedCheckpointSaver } from '../../runtime/langgraph/checkpointSaver'
import { RunMetaStore, type RunMeta } from '../../runtime/langgraph/runMetaStore'
import type { RunAuditEvent, RunAuditStore } from '../../runtime/runAudit'
import { RunService } from '../../runtime/runService'
import type { RunState, RunStep, WorkflowRuntime } from '../../runtime/port'
import type { WorkflowSpec } from '../../runtime/spec'

let counter = 0
function tempDir(): vscode.Uri {
  return vscode.Uri.file(path.join(os.tmpdir(), `sdlc-lg-test-${process.pid}-${Date.now()}-${++counter}`))
}

const STEP = (id: string, status: RunStep['status'] = 'succeeded'): RunStep => ({
  id,
  nodeId: id,
  kind: 'agent',
  label: id,
  seq: 1,
  status,
  startedAt: 1,
  finishedAt: status === 'running' ? undefined : 2,
})

const RUN = (over: Partial<RunState> = {}): RunState => ({
  runId: 'run-1',
  workflowName: 'demo',
  status: 'awaiting_approval',
  actor: 'rajnish@x',
  inputs: {},
  steps: [STEP('run-1-a-1')],
  pendingApproval: { stepId: 'run-1-a-1', nodeId: 'a', question: 'Approve plan for "A"?', plan: 'the plan' },
  startedAt: 1,
  ...over,
})

/** A runtime with NO restoreRuns at all (like the in-memory interpreter): the method must be absent, not stubbed. */
class BaseRuntime implements WorkflowRuntime {
  protected listeners: Array<(s: RunState) => void> = []
  async startRun(): Promise<RunState> {
    throw new Error('not used')
  }
  async getRun(): Promise<RunState | undefined> {
    return undefined
  }
  async submitApproval(): Promise<RunState> {
    throw new Error('not used')
  }
  async cancelRun(): Promise<RunState> {
    throw new Error('not used')
  }
  onRunUpdate(listener: (s: RunState) => void): () => void {
    this.listeners.push(listener)
    return () => undefined
  }
  emit(state: RunState): void {
    for (const l of this.listeners) l(structuredClone(state))
  }
}

/** A durable runtime: hands back the runs it "found on disk". */
class FakeRuntime extends BaseRuntime {
  constructor(private readonly restored: RunState[]) {
    super()
  }
  async restoreRuns(): Promise<RunState[]> {
    return this.restored
  }
}

function auditSpy(): { store: RunAuditStore; events: RunAuditEvent[] } {
  const events: RunAuditEvent[] = []
  const store = { append: async (e: RunAuditEvent[]) => void events.push(...e) } as unknown as RunAuditStore
  return { store, events }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

suite('RunService.restore', () => {
  test('lists restored runs and fires a single change event', async () => {
    const { store } = auditSpy()
    const svc = new RunService(new FakeRuntime([RUN(), RUN({ runId: 'run-2', pendingApproval: undefined, status: 'awaiting_approval' })]), store)
    let changes = 0
    svc.onDidChange(() => (changes += 1))

    assert.strictEqual(await svc.restore(), 2)
    assert.deepStrictEqual(svc.list().map((r) => r.runId).sort(), ['run-1', 'run-2'])
    assert.strictEqual(svc.get('run-1')?.status, 'awaiting_approval')
    assert.strictEqual(changes, 1)
  })

  test('restoring a paused run writes nothing to the audit store, and later updates add only what is new', async () => {
    const { store, events } = auditSpy()
    const runtime = new FakeRuntime([RUN()])
    const svc = new RunService(runtime, store)
    await svc.restore()
    await settle()
    assert.strictEqual(events.length, 0, 'a paused run was already audited before the restart')

    // The run is approved and finishes a second step. Only that step may be audited — not run.started, not the
    // first step again, and not a second approval request.
    runtime.emit(
      RUN({ status: 'running', pendingApproval: undefined, steps: [STEP('run-1-a-1'), STEP('run-1-gate-1')] }),
    )
    await settle()
    const kinds = events.map((e) => `${e.event}:${e.stepId ?? ''}`)
    assert.deepStrictEqual(kinds, ['step:run-1-gate-1'])
  })

  test('a run restored as failed (died mid-step) records its outcome exactly once', async () => {
    const { store, events } = auditSpy()
    const failed = RUN({
      status: 'failed',
      pendingApproval: undefined,
      error: 'Run interrupted by an extension restart before it could finish.',
      steps: [STEP('run-1-a-1', 'running')],
    })
    const svc = new RunService(new FakeRuntime([failed]), store)
    await svc.restore()
    await settle()
    assert.deepStrictEqual(events.map((e) => e.event), ['run.failed'])
    assert.ok(events[0].detail?.includes('interrupted'))
  })

  test('is a no-op for a runtime with no durable store', async () => {
    const { store, events } = auditSpy()
    const runtime = new BaseRuntime()
    assert.strictEqual((runtime as { restoreRuns?: unknown }).restoreRuns, undefined, 'precondition: no restoreRuns')
    const svc = new RunService(runtime, store)
    let changes = 0
    svc.onDidChange(() => (changes += 1))
    assert.strictEqual(await svc.restore(), 0)
    assert.deepStrictEqual(svc.list(), [])
    assert.strictEqual(changes, 0)
    assert.strictEqual(events.length, 0)
  })
})

suite('FileBackedCheckpointSaver', () => {
  // A one-node graph is enough to produce real checkpoints in a thread.
  const State = Annotation.Root({ n: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }) })
  const buildApp = (saver: FileBackedCheckpointSaver) =>
    new StateGraph(State)
      .addNode('bump', () => ({ n: 1 }))
      .addEdge(START, 'bump')
      .addEdge('bump', END)
      .compile({ checkpointer: saver })
  const cfg = (id: string) => ({ configurable: { thread_id: id } })

  test('checkpoints survive a new saver over the same storage (the restart case)', async () => {
    const dir = tempDir()
    const a = new FileBackedCheckpointSaver(dir)
    await buildApp(a).invoke({ n: 1 }, cfg('t1'))
    await a.flush()

    const b = new FileBackedCheckpointSaver(dir)
    assert.ok(await b.getTuple(cfg('t1')), 'thread reloaded from disk')
  })

  test('deleteThread is persisted, not just applied in memory', async () => {
    const dir = tempDir()
    const a = new FileBackedCheckpointSaver(dir)
    await buildApp(a).invoke({ n: 1 }, cfg('t1'))
    await a.deleteThread('t1')
    await a.flush()
    assert.strictEqual(await new FileBackedCheckpointSaver(dir).getTuple(cfg('t1')), undefined)
  })

  test('pruneOrphans removes threads that no run owns and keeps the ones that are listed', async () => {
    const dir = tempDir()
    const a = new FileBackedCheckpointSaver(dir)
    const app = buildApp(a)
    await app.invoke({ n: 1 }, cfg('keep'))
    await app.invoke({ n: 1 }, cfg('orphan-1'))
    await app.invoke({ n: 1 }, cfg('orphan-2'))

    assert.strictEqual(await a.pruneOrphans(new Set(['keep'])), 2)
    await a.flush()

    const reloaded = new FileBackedCheckpointSaver(dir)
    assert.ok(await reloaded.getTuple(cfg('keep')))
    assert.strictEqual(await reloaded.getTuple(cfg('orphan-1')), undefined)
    assert.strictEqual(await reloaded.getTuple(cfg('orphan-2')), undefined)
    assert.strictEqual(await reloaded.pruneOrphans(new Set(['keep'])), 0, 'nothing left to prune')
  })

  test('a burst of writes still ends in a consistent file', async () => {
    const dir = tempDir()
    const a = new FileBackedCheckpointSaver(dir)
    const app = buildApp(a)
    await Promise.all(Array.from({ length: 12 }, (_, i) => app.invoke({ n: 1 }, cfg(`burst-${i}`))))
    await a.flush()
    const reloaded = new FileBackedCheckpointSaver(dir)
    for (let i = 0; i < 12; i++) assert.ok(await reloaded.getTuple(cfg(`burst-${i}`)), `burst-${i} persisted`)
  })
})

suite('RunMetaStore', () => {
  const meta = (name: string): RunMeta => ({
    spec: { specVersion: 1, name, description: '', pattern: 'sequential', nodes: [], edges: [], budget: { maxSteps: 5, timeoutMs: 1000 } } as WorkflowSpec,
    budget: { maxSteps: 5, timeoutMs: 1000 },
    actor: 'u',
    workflowName: name,
    inputs: {},
    startedAt: 1,
  })

  test('save / get / list / delete round-trip, and survive a new store over the same storage', async () => {
    const dir = tempDir()
    const a = new RunMetaStore(dir)
    await a.save('r1', meta('one'))
    await a.save('r2', meta('two'))
    await a.delete('r1')
    await a.flush()

    assert.strictEqual(await a.get('r1'), undefined)
    const b = new RunMetaStore(dir)
    assert.deepStrictEqual((await b.list()).map((e) => e.runId), ['r2'])
    assert.strictEqual((await b.get('r2'))?.workflowName, 'two')
  })

  test('deleting an unknown run is harmless', async () => {
    const store = new RunMetaStore(tempDir())
    await store.delete('nope')
    assert.deepStrictEqual(await store.list(), [])
  })
})
