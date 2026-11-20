// Phase 4 (LangGraph) — compiles a WorkflowSpec into a real LangGraph StateGraph. The LangGraph analogue of
// compile/specToGraph.ts, but instead of producing an adjacency list for the FIFO interpreter
// (MockWorkflowRuntime) to walk, it builds an executable, checkpointed StateGraph.
//
// Reuses the existing pure orka-ported logic unchanged: RunContext (context.ts), evaluateCondition
// (conditions.ts), GuardState/BudgetExceededError (guards.ts), and parseGraph/findTrigger/successors/
// CONDITION_PRECEDENCE (graph.ts) via the same specToGraph.ts adapter MockWorkflowRuntime uses.
//
// Node-id scheme: every SpecNode becomes one LangGraph node, EXCEPT:
//   - `trigger` and `condition` kinds are never registered as nodes — a `condition` node is purely a
//     compile-time routing annotation (resolved by resolveSuccessors below, real "conditional-node graph
//     execution" via addConditionalEdges), and `trigger` is where the graph's actual START edge points.
//   - `end` is never registered — it compiles directly to LangGraph's END sentinel.
//   - `agent` expands to THREE LangGraph nodes (`__plan` -> `__approve` -> `__execute`; `:` is a reserved
//     character in LangGraph node names) so the mandatory plan-approve-execute HITL flow durably
//     checkpoints the plan BEFORE pausing (the `__approve` node's only job is the `interrupt()` call
//     itself, so replaying it on resume is side-effect-free/idempotent).
//   - `approval` expands to TWO nodes (`__begin` -> `__wait`) for the same reason (durable pending-approval
//     record before the pause).
// Every node's outgoing edges are compiled as `addConditionalEdges` (never a plain static edge) so a single
// router can (a) short-circuit to END when a node recorded a graceful run failure (RUN_FAILURE_KEY) and
// (b) resolve the spec's real IF/ELSE_IF/ELSE condition-node branching.

import { END, START, StateGraph } from '@langchain/langgraph'
import { interrupt } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { CONDITION_PRECEDENCE, findTrigger, parseGraph, successors, type ParsedGraph, type WorkflowNode } from '../graph'
import { RunContext } from '../context'
import { BudgetExceededError } from '../guards'
import { evaluateCondition } from '../conditions'
import { specToGraph } from '../compile/specToGraph'
import type { SdlcStep } from '../../eval/sdlcSteps'
import type { AgentDispatcher, ApprovalDecision, GateEvaluator, RunStep } from '../port'
import type { RunBudget, SpecNodeKind, WorkflowSpec } from '../spec'
import { RunGraphState, type RunGraphStateType, type RunGraphUpdate } from './state'
import { beginNode, errorMessage, findRunningStep, makeStep, finishStep, pauseUpdate, resumeNode, RUN_FAILURE_KEY, toUpdate } from './nodeHelpers'

export interface CompileDeps {
  dispatcher: AgentDispatcher
  gate: GateEvaluator
  now: () => number
  /** The run's cancellation signal — forwarded to dispatch and gate calls so cancel stops in-flight work. */
  signal?: AbortSignal
}

/** The value passed to `interrupt()` for both HITL kinds — read back by LangGraphWorkflowRuntime to build
 * `RunState.pendingApproval` (from a live `__interrupt__` result) or reconstruct it from a checkpointed
 * `getState().tasks[].interrupts` snapshot after an extension-host restart. */
export interface InterruptPayload {
  kind: 'agent-plan' | 'approval'
  nodeId: string
  stepId?: string
  agentId?: string
  agentName?: string
  plan?: string
  question?: string
  default?: string
}

function kindOf(node: WorkflowNode): SpecNodeKind {
  return node.data.kind as SpecNodeKind
}

/** The LangGraph node id a predecessor should target to "enter" this spec node. */
function entryId(node: WorkflowNode): string {
  const kind = kindOf(node)
  if (kind === 'end') return END
  if (kind === 'agent') return `${node.id}__plan`
  if (kind === 'approval') return `${node.id}__begin`
  return node.id
}

/** The LangGraph node id whose outgoing edges represent this spec node's successors. */
function exitId(node: WorkflowNode): string {
  const kind = kindOf(node)
  if (kind === 'agent') return `${node.id}__execute`
  if (kind === 'approval') return `${node.id}__wait`
  return node.id
}

/**
 * Resolves a spec node's real successors, transparently passing through `condition` nodes (recursively, so
 * nested branches work) and picking exactly one winning condition branch by IF/ELSE_IF/ELSE precedence —
 * mirrors MockWorkflowRuntime.nextNodes, but returns LangGraph entry ids instead of queueing.
 */
function resolveSuccessors(graph: ParsedGraph, sourceId: string, ctx: RunContext, visited: Set<string> = new Set()): string[] {
  const succs = successors(graph, sourceId)
  const conditionSuccs = succs.filter((s) => kindOf(s) === 'condition')
  const otherSuccs = succs.filter((s) => kindOf(s) !== 'condition')
  const out = otherSuccs.map((s) => entryId(s))

  if (conditionSuccs.length > 0) {
    const sorted = [...conditionSuccs].sort(
      (a, b) =>
        (CONDITION_PRECEDENCE[String(a.data.branch ?? 'IF')] ?? 0) -
        (CONDITION_PRECEDENCE[String(b.data.branch ?? 'IF')] ?? 0),
    )
    const winner = sorted.find((c) => evaluateCondition(String(c.data.predicate ?? ''), ctx)) ?? null
    if (winner && !visited.has(winner.id)) {
      out.push(...resolveSuccessors(graph, winner.id, ctx, new Set(visited).add(winner.id)))
    }
  }
  return out
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseBuilder = any

/** Registers the router that decides this node's outgoing edge(s): END on a recorded failure, else the
 * spec's real successors (plus any `extra` targets — used by GOTO to also jump to its target id). */
function wireOutgoing(
  builder: LooseBuilder,
  fromId: string,
  specSourceId: string,
  graph: ParsedGraph,
  extra?: (state: RunGraphStateType, ctx: RunContext) => string[],
): void {
  builder.addConditionalEdges(fromId, (state: RunGraphStateType) => {
    if (state.vars && state.vars[RUN_FAILURE_KEY]) return END
    const ctx = new RunContext(state.vars)
    const out = resolveSuccessors(graph, specSourceId, ctx)
    if (extra) out.push(...extra(state, ctx))
    const unique = Array.from(new Set(out))
    return unique.length > 0 ? unique : END
  })
}

export function compileStateGraph(
  spec: WorkflowSpec,
  runId: string,
  budget: RunBudget,
  deps: CompileDeps,
  checkpointer: BaseCheckpointSaver,
) {
  const { nodes, edges } = specToGraph(spec)
  const graph = parseGraph(nodes, edges)
  const trigger = findTrigger(graph)
  if (!trigger) throw new Error(`Workflow "${spec.name}" has no trigger node.`)

  const builder: LooseBuilder = new StateGraph(RunGraphState)
  const { now } = deps

  for (const node of graph.nodes.values()) {
    const kind = kindOf(node)
    const label = String(node.data.label ?? node.id)

    if (kind === 'trigger' || kind === 'condition' || kind === 'end') continue

    if (kind === 'agent') {
      const agentId = String(node.data.agentId ?? '')
      const agentName = String(node.data.agentName ?? label)
      const outputVar = String(node.data.outputVar ?? '')

      builder.addNode(`${node.id}__plan`, async (state: RunGraphStateType): Promise<RunGraphUpdate> => {
        const handle = beginNode(state, budget, now)
        const step = makeStep(state, runId,node.id, 'agent', label, now())
        try {
          const workItemId = Number(handle.ctx.get('Local.WorkItemId'))
          const result = await deps.dispatcher.dispatch({
            runId,
            nodeId: node.id,
            stepId: step.id,
            agentId,
            agentName,
            prompt: handle.ctx.getLastMessage(),
            workItem: String(handle.ctx.get('Local.WorkItem') ?? ''),
            workItemId: Number.isFinite(workItemId) && workItemId > 0 ? workItemId : undefined,
            workItemUrl: String(handle.ctx.get('Local.WorkItemUrl') ?? '') || undefined,
            phase: 'plan',
            signal: deps.signal,
          })
          handle.guard.addTokens(result.tokensIn, result.tokensOut)
          const done = { ...step, plan: result.response, tokensIn: result.tokensIn, tokensOut: result.tokensOut }
          return toUpdate(handle, [done])
        } catch (e) {
          const message =
            e instanceof BudgetExceededError ? e.message : `Agent "${agentName}" failed to plan: ${errorMessage(e)}`
          const failed = finishStep(step, 'failed', now(), message)
          return { ...toUpdate(handle, [failed]), vars: { ...handle.ctx.toBag(), [RUN_FAILURE_KEY]: message } }
        }
      })

      builder.addNode(`${node.id}__approve`, async (state: RunGraphStateType): Promise<RunGraphUpdate> => {
        const prior = findRunningStep(state, node.id)
        const decision = (await interrupt({
          kind: 'agent-plan',
          nodeId: node.id,
          stepId: prior?.id,
          agentId,
          agentName,
          plan: prior?.plan ?? '',
        })) as ApprovalDecision
        const handle = resumeNode(state, budget, now)
        const pause = pauseUpdate(state, now)
        if (!decision.approve) {
          const message = `Agent "${agentName}" plan rejected by ${decision.actor}${decision.comment ? `: ${decision.comment}` : ''}`
          const steps: RunStep[] = prior
            ? [finishStep({ ...prior, output: message }, 'blocked', now())]
            : []
          return { ...pause, vars: { ...handle.ctx.toBag(), [RUN_FAILURE_KEY]: message }, steps }
        }
        return pause
      })

      builder.addNode(`${node.id}__execute`, async (state: RunGraphStateType): Promise<RunGraphUpdate> => {
        const handle = resumeNode(state, budget, now)
        const prior = findRunningStep(state, node.id)
        try {
          const workItemId = Number(handle.ctx.get('Local.WorkItemId'))
          const result = await deps.dispatcher.dispatch({
            runId,
            nodeId: node.id,
            stepId: prior?.id,
            agentId,
            agentName,
            prompt: handle.ctx.getLastMessage(),
            workItem: String(handle.ctx.get('Local.WorkItem') ?? ''),
            workItemId: Number.isFinite(workItemId) && workItemId > 0 ? workItemId : undefined,
            workItemUrl: String(handle.ctx.get('Local.WorkItemUrl') ?? '') || undefined,
            phase: 'execute',
            approvedPlan: prior?.plan,
            signal: deps.signal,
          })
          handle.guard.addTokens(result.tokensIn, result.tokensOut)
          handle.ctx.setLastMessage(result.response)
          if (outputVar) handle.ctx.set(outputVar, result.response)
          if (result.structured) {
            for (const [k, v] of Object.entries(result.structured)) handle.ctx.set(k, v)
          }
          const base = prior ?? makeStep(state, runId,node.id, 'agent', label, now())
          const done = finishStep(
            { ...base, output: result.response, tokensIn: (base.tokensIn ?? 0) + result.tokensIn, tokensOut: (base.tokensOut ?? 0) + result.tokensOut },
            'succeeded',
            now(),
          )
          return toUpdate(handle, [done])
        } catch (e) {
          const message =
            e instanceof BudgetExceededError ? e.message : `Agent "${agentName}" failed: ${errorMessage(e)}`
          const base = prior ?? makeStep(state, runId,node.id, 'agent', label, now())
          const failed = finishStep(base, 'failed', now(), message)
          return { ...toUpdate(handle, [failed]), vars: { ...handle.ctx.toBag(), [RUN_FAILURE_KEY]: message } }
        }
      })

      builder.addEdge(`${node.id}__plan`, `${node.id}__approve`)
      builder.addConditionalEdges(`${node.id}__approve`, (state: RunGraphStateType) =>
        state.vars && state.vars[RUN_FAILURE_KEY] ? END : `${node.id}__execute`,
      )
      continue
    }

    if (kind === 'approval') {
      builder.addNode(`${node.id}__begin`, async (state: RunGraphStateType): Promise<RunGraphUpdate> => {
        const handle = beginNode(state, budget, now)
        const step = makeStep(state, runId,node.id, 'approval', label, now())
        return toUpdate(handle, [step])
      })

      builder.addNode(`${node.id}__wait`, async (state: RunGraphStateType): Promise<RunGraphUpdate> => {
        const prior = findRunningStep(state, node.id)
        const decision = (await interrupt({
          kind: 'approval',
          nodeId: node.id,
          stepId: prior?.id,
          question: String(node.data.question ?? 'Approve to continue?'),
          default: node.data.approvalDefault ? String(node.data.approvalDefault) : undefined,
        })) as ApprovalDecision
        const handle = resumeNode(state, budget, now)
        const pause = pauseUpdate(state, now)
        if (!decision.approve) {
          const message = `Approval rejected by ${decision.actor}${decision.comment ? `: ${decision.comment}` : ''}`
          const steps: RunStep[] = prior ? [finishStep({ ...prior, output: message }, 'blocked', now())] : []
          return { ...pause, vars: { ...handle.ctx.toBag(), [RUN_FAILURE_KEY]: message }, steps }
        }
        const approvalVar = String(node.data.approvalVar ?? '')
        if (approvalVar) handle.ctx.set(approvalVar, 'yes')
        const steps: RunStep[] = prior
          ? [finishStep({ ...prior, output: `approved by ${decision.actor}` }, 'succeeded', now())]
          : []
        return { ...pause, vars: handle.ctx.toBag(), steps }
      })

      builder.addEdge(`${node.id}__begin`, `${node.id}__wait`)
      continue
    }

    if (kind === 'gate') {
      builder.addNode(node.id, async (state: RunGraphStateType): Promise<RunGraphUpdate> => {
        const handle = beginNode(state, budget, now)
        const step = makeStep(state, runId,node.id, 'gate', label, now())
        const gateStep = (node.data.gateStep as SdlcStep) ?? 'implement'
        const decision = await deps.gate.evaluate({
          sdlcStep: gateStep,
          output: handle.ctx.getLastMessage(),
          query: String(handle.ctx.get('Local.WorkItem') ?? ''),
          signal: deps.signal,
        })
        const resultVar = String(node.data.gateResultVar ?? '')
        if (resultVar) handle.ctx.set(`${resultVar}.pass`, decision.pass)
        if (!decision.pass) {
          const failed = { ...step, gateDecision: decision }
          const done = finishStep(failed, 'blocked', now(), decision.reason)
          return {
            ...toUpdate(handle, [done]),
            vars: { ...handle.ctx.toBag(), [RUN_FAILURE_KEY]: `Gate (${gateStep}) blocked the run: ${decision.reason}` },
          }
        }
        const succeeded = finishStep({ ...step, gateDecision: decision }, 'succeeded', now(), decision.reason)
        return toUpdate(handle, [succeeded])
      })
      continue
    }

    if (kind === 'set-variable') {
      builder.addNode(node.id, async (state: RunGraphStateType): Promise<RunGraphUpdate> => {
        const handle = beginNode(state, budget, now)
        const step = makeStep(state, runId,node.id, 'set-variable', label, now())
        const variable = String(node.data.variable ?? '')
        if (variable) handle.ctx.set(variable, handle.ctx.interpolate(node.data.value))
        return toUpdate(handle, [finishStep(step, 'succeeded', now())])
      })
      continue
    }

    if (kind === 'goto') {
      builder.addNode(node.id, async (state: RunGraphStateType): Promise<RunGraphUpdate> => {
        const handle = beginNode(state, budget, now)
        const step = makeStep(state, runId,node.id, 'goto', label, now())
        return toUpdate(handle, [finishStep(step, 'succeeded', now())])
      })
      continue
    }
  }

  // Wire the graph's real entry point: START -> the trigger's resolved successors.
  wireOutgoing(builder, START, trigger.id, graph)

  // Wire every executable node's outgoing edges from its spec successors.
  for (const node of graph.nodes.values()) {
    const kind = kindOf(node)
    if (kind === 'trigger' || kind === 'condition' || kind === 'end') continue
    const extra =
      kind === 'goto'
        ? () => {
            const targetId = String(node.data.targetId ?? '')
            const targetNode = targetId ? graph.nodes.get(targetId) : undefined
            return targetNode ? [entryId(targetNode)] : []
          }
        : undefined
    wireOutgoing(builder, exitId(node), node.id, graph, extra)
  }

  return builder.compile({ checkpointer })
}
