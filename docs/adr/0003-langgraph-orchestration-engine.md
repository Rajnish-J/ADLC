# ADR 0003 — LangGraph.js as a second WorkflowRuntime engine

- **Status:** Accepted
- **Date:** 2026-07-26
- **Supersedes / relates to:** ADR 0002 (Phase 4 orchestration engine). Where 0002 explored operating the
  workflow engine on an external host (Foundry-declarative YAML, or an in-process Python/C# SDK runner),
  what actually shipped was `MockWorkflowRuntime` — an in-process, hand-rolled FIFO-queue interpreter of the
  `WorkflowSpec` IR (`src/runtime/mock/mockRuntime.ts`), reusing pure logic ported from the `orka` project
  (`context.ts`, `conditions.ts`, `guards.ts`, `graph.ts`). This ADR documents the decision to add a second
  `WorkflowRuntime` implementation on top of that interpreter, not to revisit the host-location question.

## Context

The interpreter is genuinely bespoke: branching is modeled as pass-through "condition" nodes a hand-rolled
`nextNodes()` special-cases by precedence (not real conditional edges), loops are a `goto` node re-enqueuing
a target id, and all run state — including a paused, awaiting-approval run — lives only in an in-process
`Map`. A paused run does not survive an extension-host restart. Branching/looping work, but they are not a
real graph-execution engine, and there was no path to durable human-in-the-loop pauses.

`@langchain/langgraph` (LangGraph.js) provides exactly this: a `StateGraph` with real conditional edges,
native cycle support, and an `interrupt()` + checkpointer + `Command({ resume })` pattern purpose-built for
durable human-in-the-loop pauses. No LangChain/LangGraph dependency existed in this repo before this change.

## Decision

Add `LangGraphWorkflowRuntime` (`src/runtime/langgraph/langGraphRuntime.ts`) as a second, complete
implementation of the existing `WorkflowRuntime` port (`src/runtime/port.ts`) — the same seam the port's own
header comment already anticipated a second implementation would use. Both engines are kept available behind
a new setting, `sdlcGovernance.runtime.engine` (`interpreter` default, `langgraph` opt-in), rather than a hard
cutover — `interpreter` remains the offline/mock-dispatch CI test path, and switching engines is reversible.

Key design choices, in `src/runtime/langgraph/`:

- **`specToStateGraph.ts`** compiles the unchanged `WorkflowSpec` IR into a `StateGraph`. `agent` nodes
  expand into three LangGraph nodes (`__plan` → `__approve` → `__execute`; `agent`'s plan is durably
  checkpointed *before* the pause, and the `__approve` node's only job is the `interrupt()` call itself, so
  replaying it on resume is side-effect-free). Plain `approval` nodes expand into two (`__begin` → `__wait`)
  for the same reason. `condition` IR nodes are **not** LangGraph nodes at all — they compile to real
  `addConditionalEdges` routers (reusing `evaluateCondition`/`CONDITION_PRECEDENCE` unchanged), which is
  closer to genuine "conditional-node graph execution" than the interpreter's pass-through-node modeling.
  `goto` compiles to a plain cycle edge — LangGraph supports cycles natively.
- **Guarding**: `GuardState`/`BudgetExceededError` (`guards.ts`) are reused unchanged, reconstructed from the
  state annotation on every node call (LangGraph node functions must not depend on captured mutable state
  across a checkpoint/replay) rather than LangGraph's own `recursionLimit`, which isn't a semantic substitute
  for `maxSteps`/`timeoutMs`/`maxTokens`.
- **Durability**: a custom `FileBackedCheckpointSaver` (`checkpointSaver.ts`) subclasses LangGraph's
  `MemorySaver` and mirrors its storage to a JSON file via `vscode.workspace.fs`, avoiding the native
  `better-sqlite3` dependency `@langchain/langgraph-checkpoint-sqlite` would pull into the esbuild-bundled
  extension host. `RunMetaStore` (`runMetaStore.ts`) persists the small amount of metadata (spec, budget,
  actor) needed to recompile a run's graph after a restart — the checkpointer alone durably stores LangGraph's
  channel state, but recompiling node functions needs the original spec again.
- **Live introspection**: `LmAgentDispatcher` gained an `observeFragments()` hook (independent of its
  existing `bind()`/`ctx`, so it never disturbs the chat participant's binding) that `LangGraphWorkflowRuntime`
  uses to patch a new, additive `RunStep.activity` field (current streamed thought + live token estimate)
  directly onto its own `RunState` mirror, throttled before broadcasting via the existing `onRunUpdate`
  mechanism. The canvas gained a click-to-expand `NodeIntrospectionCard` for a running agent node. Both are
  additive to `RunState`/the webview protocol — absent entirely for `MockWorkflowRuntime` runs.
- **Dispatch layer unchanged**: `LmAgentDispatcher`'s hand-rolled ReAct loop against `vscode.lm` is called
  through the same `AgentDispatcher` port from LangGraph node functions — no LangChain `BaseChatModel`
  adapter, no `createReactAgent`/`ToolNode` prebuilts. The mandatory plan→approve→execute split doesn't map
  onto those prebuilts' single-continuous-tool-loop model, and the dispatcher is already hand-tuned to
  `vscode.lm`'s actual message/tool-call API.

## Consequences

- _Positive:_ real conditional-edge routing and native cycle support; durable HITL pauses that survive a VS
  Code reload; live per-node introspection on the canvas; `RunService`, the webview, the chat participant,
  and `runAudit.ts` needed zero changes (verified: `src/test/runtime/sdlcDefaultWorkflow.test.ts` confirms
  the audit-event shape is identical across engines for the same spec).
- _Negative / risks:_ two orchestration engines now coexist (deliberate, see above) — `specToGraph.ts`/
  `mockRuntime.ts` and `specToStateGraph.ts`/`langGraphRuntime.ts` must both be maintained until a later,
  deliberate hard cutover. `@langchain/langgraph` is a new dependency surface; verified to bundle cleanly
  through esbuild for the Node18/CJS extension-host target (no ESM/native-module issues found).
- _Follow-ups:_ decide when (if ever) to retire `MockWorkflowRuntime`; consider a `BaseChatModel` adapter
  only if LangGraph-native `streamMode: 'messages'` token events are wanted in place of the
  `observeFragments()` bridge — not needed for anything shipped here.

## Status update — 2026-10-30: gaps closed, `langgraph` is now the default

An audit found that the engine was complete as an opt-in but not safe to be the default. What changed, and why:

- **Default flipped.** `sdlcGovernance.runtime.engine` now defaults to `langgraph`; `interpreter` stays selectable
  and is still the path with no durable store. The engine is read once at activation, so changing the setting
  prompts for a window reload.
- **Streaming instead of invoke.** `LangGraphWorkflowRuntime` now uses `graph.stream` (modes `updates` + `tasks`).
  Finished steps are folded into the `RunState` mirror as they land, and a `running` step is shown the moment a
  node's task starts — including during the plan phase. The checkpoint (`getState`) stays authoritative: it is
  read after every stream to decide paused / completed / failed.
- **Parallel-safe state.** `stepCount`/`tokenCount` are delta channels (nodes return what they added; the reducer
  sums) and step `seq` is assigned in the `steps` reducer. Step ids are `<runId>-<nodeId>-<n>`, unique across
  parallel branches and goto loops, and computable from a node's input — which is how a provisional running step
  gets the same id as the real one. Fan-out join semantics intentionally follow LangGraph (a node reached by
  several branches in one superstep runs once), which differs from the interpreter's one-run-per-arrival queue.
- **Real cancel.** A per-run `AbortController` aborts the stream (LangGraph raises `AbortError` promptly, even
  while a node is still awaiting) and its signal is passed to the dispatcher and gate, so `LmAgentDispatcher`
  cancels its model request. A late-finishing node cannot overwrite the `cancelled` state.
- **Runs are retired, not accumulated.** On completed / failed / cancelled the run's checkpoint thread and run
  metadata are deleted (terminal history lives in `RunService` and the run audit). Because cancel deletes the
  checkpoint, a cancelled run can no longer be resurrected as `awaiting_approval` after a reload. Both JSON files
  coalesce writes, and `FileBackedCheckpointSaver.pruneOrphans` sweeps threads with no run metadata at restore time.
- **Restore.** `WorkflowRuntime` gained an optional `restoreRuns()`; `RunService.restore()` runs at activation,
  primes the audit de-duplication so nothing is double-logged, and surfaces paused runs in the Runs tree. A run
  whose snapshot shows work still queued (the host died mid-step) is reported once as `failed` rather than left
  `running` forever; paused runs older than 14 days are discarded. Run ids now include the start time, because a
  per-session counter would collide with a restored run's checkpoint thread after a reload.
- **Real gate.** `StubGateEvaluator` is no longer what runs by default: `FoundryGateEvaluator` evaluates a step's
  output with the Phase-3 pipeline (`buildDataset` → Foundry evaluators → `decideGate`). `gate.evaluator` is
  `auto` (Foundry when signed in and `gate.projectEndpoint` is set, else the stub — loudly, with verdicts
  labelled), `foundry`, or `stub`. Evaluators that need tool-call data (`tool_call_accuracy`, a REQUIRED evaluator
  in the default implement/review steps) cannot run on an in-run gate and are skipped, with the skip recorded in
  the decision; otherwise a fail-closed policy would block every such step. `decideGate` is called with
  `LOWER_IS_BETTER` so safety severities are judged in the right direction.
- **Verified against LangGraph 1.4.8** by a probe before implementation: `tasks` start events carry the node name
  and its full input state; an interrupt arrives as `{ __interrupt__: [...] }` in `updates` mode; `deleteThread`
  leaves `getState` returning `next: []` and empty `values`, so "no checkpoint" must never be read as "completed"
  — restore keys off run metadata for that reason.
- **Still open.** Retiring `MockWorkflowRuntime`; resuming a run from its last checkpoint after a mid-step crash
  instead of reporting it failed; and the live-Foundry path of the real gate, which has only been tested offline.
