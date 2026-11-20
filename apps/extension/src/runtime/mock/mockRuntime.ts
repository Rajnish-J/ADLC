// Phase 4 — MockWorkflowRuntime: an in-process interpreter of a WorkflowSpec.
//
// Implements the WorkflowRuntime port using the harvested orka pure logic (graph / conditions / context /
// guards). It genuinely executes the workflow — sequential chaining, handoff routing, real pause/resume on
// approval, gate halt-on-fail, and budget caps — dispatching agents and gates through injected ports. No
// Azure, no network. The production FoundryWorkflowRuntime implements the same port later (P4.0 spike).
//
// State is held live in memory (the mock owns durability; the real runtime delegates it to Foundry), so a
// paused run keeps its RunContext / GuardState / queue as live objects — no serialization needed.

import { CONDITION_PRECEDENCE, findTrigger, parseGraph, successors, type ParsedGraph, type WorkflowNode } from '../graph'
import { RunContext } from '../context'
import { BudgetExceededError, GuardState } from '../guards'
import { evaluateCondition } from '../conditions'
import { specToGraph } from '../compile/specToGraph'
import type { SdlcStep } from '../../eval/sdlcSteps'
import type {
  AgentDispatcher,
  ApprovalDecision,
  GateEvaluator,
  PendingApproval,
  RunState,
  RunStep,
  StartRunArgs,
  Unsubscribe,
  WorkflowRuntime,
} from '../port'
import type { RunBudget } from '../spec'

interface RunContextState {
  state: RunState
  graph: ParsedGraph
  ctx: RunContext
  guard: GuardState
  queue: string[]
  seq: number
  cancelRequested: boolean
  dispatcher: AgentDispatcher
  gate: GateEvaluator
  /** The approval node id the run is currently paused on, if any. */
  pausedOn?: string
  /** When the current pause began — the gap until resume is excluded from the time budget. */
  pausedAt?: number
  /** Set while paused on an agent's plan — every AGENT node pauses for human approval before it runs. */
  pendingAgent?: {
    nodeId: string
    stepId: string
    agentId: string
    agentName: string
    plan: string
  }
}

export interface MockRuntimeDeps {
  dispatcher: AgentDispatcher
  gate: GateEvaluator
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number
  /** Counter seed for deterministic run ids in tests. */
  idSeed?: number
}

export class MockWorkflowRuntime implements WorkflowRuntime {
  private readonly runs = new Map<string, RunContextState>()
  private readonly listeners = new Set<(state: RunState) => void>()
  private readonly now: () => number
  private idCounter: number

  constructor(private readonly deps: MockRuntimeDeps) {
    this.now = deps.now ?? Date.now
    this.idCounter = deps.idSeed ?? 0
  }

  onRunUpdate(listener: (state: RunState) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(state: RunState): void {
    for (const l of this.listeners) l(structuredClone(state))
  }

  async startRun(args: StartRunArgs): Promise<RunState> {
    const runId = args.runId ?? `mock-run-${++this.idCounter}`
    if (this.runs.has(runId)) throw new Error(`Run id already in use: ${runId}`)
    const budget: RunBudget = args.budget ?? args.spec.budget
    const { nodes, edges } = specToGraph(args.spec)
    const graph = parseGraph(nodes, edges)

    const ctx = new RunContext()
    const inputs = args.inputs ?? {}
    for (const [k, v] of Object.entries(inputs)) ctx.set(k, v)
    const seed = String(inputs.task ?? inputs.message ?? inputs.prompt ?? '')
    ctx.setLastMessage(seed)
    // Persist the work item / task seed under stable keys so EVERY agent step can see it — unlike
    // System.LastMessage.Text, which each agent overwrites with its own reply. Without this, only the
    // first agent ever sees the work item and downstream agents grope around asking for it.
    ctx.set('Local.WorkItem', seed)
    if (inputs.workItemId !== undefined) ctx.set('Local.WorkItemId', inputs.workItemId)
    if (inputs.workItemUrl !== undefined) ctx.set('Local.WorkItemUrl', inputs.workItemUrl)

    const state: RunState = {
      runId,
      workflowName: args.spec.name,
      status: 'running',
      actor: args.actor,
      inputs,
      steps: [],
      startedAt: this.now(),
    }

    const trigger = findTrigger(graph)
    const rc: RunContextState = {
      state,
      graph,
      ctx,
      guard: new GuardState(budget, this.now()),
      queue: trigger ? [trigger.id] : [],
      seq: 0,
      cancelRequested: false,
      dispatcher: this.deps.dispatcher,
      gate: this.deps.gate,
    }
    this.runs.set(runId, rc)
    this.emit(state)

    await this.drive(rc)
    return structuredClone(rc.state)
  }

  async getRun(runId: string): Promise<RunState | undefined> {
    const rc = this.runs.get(runId)
    return rc ? structuredClone(rc.state) : undefined
  }

  async submitApproval(runId: string, decision: ApprovalDecision): Promise<RunState> {
    const rc = this.runs.get(runId)
    if (!rc) throw new Error(`Unknown run: ${runId}`)
    if (rc.state.status !== 'awaiting_approval' || (!rc.pausedOn && !rc.pendingAgent)) {
      throw new Error(`Run ${runId} is not awaiting approval (status: ${rc.state.status}).`)
    }
    if (rc.pausedAt !== undefined) {
      rc.guard.addPausedMs(this.now() - rc.pausedAt)
      rc.pausedAt = undefined
    }

    // Paused on a mandatory agent plan (every AGENT node pauses here before it runs).
    if (rc.pendingAgent) {
      return this.resumeAgent(rc, decision)
    }

    const approvalNode = rc.graph.nodes.get(rc.pausedOn!)
    const pausedStep = rc.state.steps.find((s) => s.nodeId === rc.pausedOn && s.status === 'running')

    // Record the decision on the paused approval step.
    if (pausedStep) {
      pausedStep.status = decision.approve ? 'succeeded' : 'blocked'
      pausedStep.output = `${decision.approve ? 'approved' : 'rejected'} by ${decision.actor}${
        decision.comment ? `: ${decision.comment}` : ''
      }`
      pausedStep.finishedAt = this.now()
    }

    if (!decision.approve) {
      this.fail(rc, `Approval rejected by ${decision.actor}.`)
      return structuredClone(rc.state)
    }

    // Approved: store the answer, clear the pause, enqueue the approval node's successors, continue.
    if (approvalNode) {
      const approvalVar = String(approvalNode.data.approvalVar ?? '')
      if (approvalVar) rc.ctx.set(approvalVar, 'yes')
      for (const id of this.nextNodes(rc, approvalNode)) rc.queue.push(id)
    }
    rc.pausedOn = undefined
    rc.state.pendingApproval = undefined
    rc.state.status = 'running'
    this.emit(rc.state)

    await this.drive(rc)
    return structuredClone(rc.state)
  }

  /** Resume a run paused on an agent's plan: reject halts the whole run, approve executes the plan. */
  private async resumeAgent(rc: RunContextState, decision: ApprovalDecision): Promise<RunState> {
    const pending = rc.pendingAgent!
    const node = rc.graph.nodes.get(pending.nodeId)
    const step = rc.state.steps.find((s) => s.id === pending.stepId)

    if (!decision.approve) {
      if (step) {
        step.status = 'blocked'
        step.output = `Plan rejected by ${decision.actor}${decision.comment ? `: ${decision.comment}` : ''}`
        step.finishedAt = this.now()
      }
      rc.pendingAgent = undefined
      this.fail(rc, `Agent "${pending.agentName}" plan rejected by ${decision.actor}.`)
      return structuredClone(rc.state)
    }

    rc.state.pendingApproval = undefined
    rc.state.status = 'running'
    this.emit(rc.state)

    try {
      const workItemId = Number(rc.ctx.get('Local.WorkItemId'))
      const result = await rc.dispatcher.dispatch({
        runId: rc.state.runId,
        nodeId: pending.nodeId,
        stepId: pending.stepId,
        agentId: pending.agentId,
        agentName: pending.agentName,
        prompt: rc.ctx.getLastMessage(),
        workItem: String(rc.ctx.get('Local.WorkItem') ?? ''),
        workItemId: Number.isFinite(workItemId) && workItemId > 0 ? workItemId : undefined,
        workItemUrl: String(rc.ctx.get('Local.WorkItemUrl') ?? '') || undefined,
        phase: 'execute',
        approvedPlan: pending.plan,
      })
      rc.ctx.setLastMessage(result.response)
      if (node) {
        const outputVar = String(node.data.outputVar ?? '')
        if (outputVar) rc.ctx.set(outputVar, result.response)
      }
      if (result.structured) {
        for (const [k, v] of Object.entries(result.structured)) rc.ctx.set(k, v)
      }
      rc.guard.addTokens(result.tokensIn, result.tokensOut)
      if (step) {
        step.output = result.response
        step.tokensIn = (step.tokensIn ?? 0) + result.tokensIn
        step.tokensOut = (step.tokensOut ?? 0) + result.tokensOut
      }
      if (step) this.finishStep(rc, step, 'succeeded')
      rc.pendingAgent = undefined
      if (node) this.enqueueSuccessors(rc, node)
    } catch (e) {
      rc.pendingAgent = undefined
      if (e instanceof BudgetExceededError) {
        if (step) this.finishStep(rc, step, 'failed', e.message)
        this.fail(rc, e.message)
        return structuredClone(rc.state)
      }
      const message = e instanceof Error ? e.message : String(e)
      if (step) this.finishStep(rc, step, 'failed', message)
      this.fail(rc, `Agent "${pending.agentName}" failed: ${message}`)
      return structuredClone(rc.state)
    }

    await this.drive(rc)
    return structuredClone(rc.state)
  }

  async cancelRun(runId: string): Promise<RunState> {
    const rc = this.runs.get(runId)
    if (!rc) throw new Error(`Unknown run: ${runId}`)
    if (['completed', 'failed', 'cancelled'].includes(rc.state.status)) {
      return structuredClone(rc.state)
    }
    rc.cancelRequested = true
    // If paused, there is no active loop to observe the flag — cancel synchronously.
    if (rc.state.status === 'awaiting_approval') {
      rc.state.pendingApproval = undefined
      rc.pausedOn = undefined
      rc.state.status = 'cancelled'
      rc.state.finishedAt = this.now()
      this.emit(rc.state)
    }
    return structuredClone(rc.state)
  }

  // --- core loop -------------------------------------------------------------------------------

  private async drive(rc: RunContextState): Promise<void> {
    while (rc.queue.length > 0) {
      if (rc.cancelRequested) {
        rc.state.status = 'cancelled'
        rc.state.finishedAt = this.now()
        this.emit(rc.state)
        return
      }

      const nodeId = rc.queue.shift() as string
      const node = rc.graph.nodes.get(nodeId)
      if (!node) continue

      try {
        rc.guard.tick(this.now())
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          this.fail(rc, e.message)
          return
        }
        throw e
      }

      const ended = await this.executeNode(rc, node)
      if (ended) return // end, pause, or fail already set terminal/paused state
    }

    // Queue drained without an explicit END → complete.
    if (rc.state.status === 'running') {
      rc.state.status = 'completed'
      rc.state.outputs = rc.ctx.toBag()
      rc.state.finishedAt = this.now()
      this.emit(rc.state)
    }
  }

  /** Returns true when the run should stop driving (ended, paused, or failed). */
  private async executeNode(rc: RunContextState, node: WorkflowNode): Promise<boolean> {
    const type = node.type
    const label = String(node.data.label ?? node.id)

    switch (type) {
      case 'END': {
        rc.state.status = 'completed'
        rc.state.outputs = rc.ctx.toBag()
        rc.state.finishedAt = this.now()
        this.emit(rc.state)
        return true
      }

      case 'AGENT': {
        // Every agent is mandatory human-in-the-loop: generate a tool-free plan, then pause for
        // approval. Execution (phase: 'execute') happens in resumeAgent() once a human approves —
        // a rejection halts the whole run (see submitApproval / resumeAgent).
        const step = this.beginStep(rc, node, 'agent', label)
        const agentId = String(node.data.agentId ?? '')
        const agentName = String(node.data.agentName ?? label)
        try {
          const workItemId = Number(rc.ctx.get('Local.WorkItemId'))
          const result = await rc.dispatcher.dispatch({
            runId: rc.state.runId,
            nodeId: node.id,
            stepId: step.id,
            agentId,
            agentName,
            prompt: rc.ctx.getLastMessage(),
            workItem: String(rc.ctx.get('Local.WorkItem') ?? ''),
            workItemId: Number.isFinite(workItemId) && workItemId > 0 ? workItemId : undefined,
            workItemUrl: String(rc.ctx.get('Local.WorkItemUrl') ?? '') || undefined,
            phase: 'plan',
          })
          rc.guard.addTokens(result.tokensIn, result.tokensOut)
          step.plan = result.response
          step.tokensIn = result.tokensIn
          step.tokensOut = result.tokensOut
        } catch (e) {
          if (e instanceof BudgetExceededError) {
            this.finishStep(rc, step, 'failed', e.message)
            this.fail(rc, e.message)
            return true
          }
          this.finishStep(rc, step, 'failed', e instanceof Error ? e.message : String(e))
          this.fail(rc, `Agent "${agentName}" failed to plan: ${e instanceof Error ? e.message : String(e)}`)
          return true
        }

        rc.pendingAgent = { nodeId: node.id, stepId: step.id, agentId, agentName, plan: step.plan }
        rc.state.pendingApproval = {
          stepId: step.id,
          nodeId: node.id,
          question: `Approve plan for "${agentName}"?`,
          plan: step.plan,
        }
        rc.state.status = 'awaiting_approval'
        rc.pausedAt = this.now()
        this.emit(rc.state)
        return true // stop driving until submitApproval resumes us
      }

      case 'GATE': {
        const step = this.beginStep(rc, node, 'gate', label)
        const gateStep = (node.data.gateStep as SdlcStep) ?? 'implement'
        const decision = await rc.gate.evaluate({
          sdlcStep: gateStep,
          output: rc.ctx.getLastMessage(),
          query: String(rc.ctx.get('Local.WorkItem') ?? ''),
        })
        step.gateDecision = decision
        const resultVar = String(node.data.gateResultVar ?? '')
        if (resultVar) rc.ctx.set(`${resultVar}.pass`, decision.pass)
        if (!decision.pass) {
          this.finishStep(rc, step, 'blocked', decision.reason)
          this.fail(rc, `Gate (${gateStep}) blocked the run: ${decision.reason}`)
          return true
        }
        this.finishStep(rc, step, 'succeeded', decision.reason)
        this.enqueueSuccessors(rc, node)
        return false
      }

      case 'APPROVAL': {
        // Pause. Open a 'running' step that submitApproval will close.
        const step = this.beginStep(rc, node, 'approval', label)
        const pending: PendingApproval = {
          stepId: step.id,
          nodeId: node.id,
          question: String(node.data.question ?? 'Approve to continue?'),
          default: node.data.approvalDefault ? String(node.data.approvalDefault) : undefined,
        }
        rc.pausedOn = node.id
        rc.state.pendingApproval = pending
        rc.state.status = 'awaiting_approval'
        rc.pausedAt = this.now()
        this.emit(rc.state)
        return true // stop driving until submitApproval resumes us
      }

      case 'SET_VARIABLE': {
        const step = this.beginStep(rc, node, 'set-variable', label)
        const variable = String(node.data.variable ?? '')
        if (variable) rc.ctx.set(variable, rc.ctx.interpolate(node.data.value))
        this.finishStep(rc, step, 'succeeded')
        this.enqueueSuccessors(rc, node)
        return false
      }

      case 'GOTO': {
        const step = this.beginStep(rc, node, 'goto', label)
        const targetId = String(node.data.targetId ?? '')
        this.finishStep(rc, step, 'succeeded')
        if (targetId && rc.graph.nodes.has(targetId)) rc.queue.push(targetId)
        this.enqueueSuccessors(rc, node)
        return false
      }

      case 'CONDITION':
      case 'TRIGGER':
      default: {
        // Pass-through nodes: route via successors (condition switch applies in nextNodes).
        this.enqueueSuccessors(rc, node)
        return false
      }
    }
  }

  private enqueueSuccessors(rc: RunContextState, node: WorkflowNode): void {
    for (const id of this.nextNodes(rc, node)) rc.queue.push(id)
  }

  /**
   * Successor selection. Non-condition successors are always enqueued. Among CONDITION successors, exactly
   * one winning branch is chosen by precedence (IF, ELSE_IF…, ELSE) — mirrors the orka executor.
   */
  private nextNodes(rc: RunContextState, node: WorkflowNode): string[] {
    const succs = successors(rc.graph, node.id)
    const conditions = succs.filter((s) => s.type === 'CONDITION')
    const others = succs.filter((s) => s.type !== 'CONDITION')
    const out = others.map((s) => s.id)

    if (conditions.length > 0) {
      const sorted = [...conditions].sort(
        (a, b) =>
          (CONDITION_PRECEDENCE[String(a.data.branch ?? 'IF')] ?? 0) -
          (CONDITION_PRECEDENCE[String(b.data.branch ?? 'IF')] ?? 0),
      )
      const winner =
        sorted.find((c) => evaluateCondition(String(c.data.predicate ?? ''), rc.ctx)) ?? null
      if (winner) out.push(winner.id)
    }
    return out
  }

  // --- step + status helpers -------------------------------------------------------------------

  private beginStep(
    rc: RunContextState,
    node: WorkflowNode,
    kind: RunStep['kind'],
    label: string,
  ): RunStep {
    const step: RunStep = {
      id: `${rc.state.runId}-step-${++rc.seq}`,
      nodeId: node.id,
      kind,
      label,
      seq: rc.seq,
      status: 'running',
      startedAt: this.now(),
    }
    rc.state.steps.push(step)
    this.emit(rc.state)
    return step
  }

  private finishStep(rc: RunContextState, step: RunStep, status: RunStep['status'], error?: string): void {
    step.status = status
    if (error) step.error = error
    step.finishedAt = this.now()
    this.emit(rc.state)
  }

  private fail(rc: RunContextState, error: string): void {
    rc.state.status = 'failed'
    rc.state.error = error
    rc.state.outputs = rc.ctx.toBag()
    rc.state.finishedAt = this.now()
    rc.state.pendingApproval = undefined
    rc.pausedOn = undefined
    this.emit(rc.state)
  }
}
