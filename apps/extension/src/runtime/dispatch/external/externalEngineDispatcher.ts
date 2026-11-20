// Dispatches a run's agent steps to the harness the user chose (Copilot, Claude Code, Codex…) instead of calling a
// model directly: each plan/execute dispatch is parked on the StepChannel until the harness — driven by the SDLC
// tools it calls — picks the step up, submits its plan and completes it. Gates and approvals still run in our
// runtime between steps, so governance is unchanged. Runs not bound here go to the fallback (see RoutingDispatcher).

import type { AgentDispatchInput, AgentDispatchResult, AgentDispatcher } from '../../port'
import { StepChannel, type ChannelEvent, type SkillRef, type StepExtras } from './stepChannel'

export interface ExternalRunBinding {
  runId: string
  /** The harness id (`copilot`, `claude-code`, …). */
  engine: string
  engineModel?: string | null
  /** Skills per agent node, with where they were materialized in the workspace. */
  skillsByNode: Record<string, SkillRef[]>
  /** Each catalog agent's instructions and the file they were written to, by agent slug. */
  agents?: Record<string, { instructions: string; file?: string }>
  /** Called whenever a step is handed to the harness, so the user can be nudged to continue. */
  onDelivered?: (input: AgentDispatchInput) => void
}

export class ExternalEngineDispatcher implements AgentDispatcher {
  private readonly bindings = new Map<string, ExternalRunBinding>()
  private readonly waitingFor = new Map<string, 'approval' | 'gate' | 'idle'>()
  readonly channel: StepChannel

  constructor() {
    this.channel = new StepChannel(
      (runId, nodeId, agentId): StepExtras => {
        const b = this.bindings.get(runId)
        const agent = b?.agents?.[agentId]
        return { skills: b?.skillsByNode[nodeId] ?? [], agentInstructions: agent?.instructions, agentFile: agent?.file }
      },
      (runId) => this.waitingFor.get(runId) ?? 'idle',
    )
    this.channel.onEvent((e) => {
      if (e.type === 'delivered') this.bindings.get(e.runId)?.onDelivered?.(e.input)
    })
  }

  bindRun(binding: ExternalRunBinding): void {
    this.bindings.set(binding.runId, binding)
  }

  binding(runId: string): ExternalRunBinding | undefined {
    return this.bindings.get(runId)
  }

  has(runId: string | undefined): boolean {
    return !!runId && this.bindings.has(runId)
  }

  /** What the run is waiting on while no step is with the harness (shown to the harness when it polls). */
  setWaiting(runId: string, reason: 'approval' | 'gate' | 'idle'): void {
    this.waitingFor.set(runId, reason)
  }

  onEvent(fn: (e: ChannelEvent) => void): { dispose(): void } {
    return this.channel.onEvent(fn)
  }

  dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
    if (input.runId) this.waitingFor.set(input.runId, 'idle')
    return this.channel.enqueue(input)
  }

  /** The run ended: release the harness (its next poll says done/stopped) and forget the binding. */
  releaseRun(runId: string, outcome: 'done' | 'stopped', reason?: string): void {
    if (!this.bindings.has(runId)) return
    this.channel.finish(runId, outcome, reason)
    this.bindings.delete(runId)
    this.waitingFor.delete(runId)
  }
}

/** Sends harness runs to the external dispatcher and everything else (LM, stub) to the fallback. */
export class RoutingDispatcher implements AgentDispatcher {
  constructor(
    private readonly external: ExternalEngineDispatcher,
    private readonly fallback: AgentDispatcher,
  ) {}

  dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
    return this.external.has(input.runId) ? this.external.dispatch(input) : this.fallback.dispatch(input)
  }

  /** Live streamed fragments come from the fallback (the LM dispatcher); harness runs report activity separately. */
  observeFragments(fn: (agentName: string, fragment: string, source?: { runId?: string; stepId?: string }) => void): { dispose(): void } {
    const f = this.fallback as { observeFragments?: (cb: typeof fn) => { dispose(): void } }
    return typeof f.observeFragments === 'function' ? f.observeFragments(fn) : { dispose: () => {} }
  }
}
