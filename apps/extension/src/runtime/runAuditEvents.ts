// Pure run-audit event model + derivation, split from runAudit.ts so it carries no `vscode` dependency.
// Mirrors the orka `orkaWorkflowAudit` event-log shape (run/step/audit). The extension's RunAuditStore writes
// these to JSONL; the backend writes the same events to its append-only audit table.

import type { RunState, RunStep } from './port'

export type RunAuditEventKind =
  | 'run.started'
  | 'step'
  | 'approval.requested'
  | 'approval.decided'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'

export interface RunAuditEvent {
  schemaVersion: 1
  runId: string
  workflowName: string
  actor: string
  timestamp: string // ISO8601
  event: RunAuditEventKind
  status: RunState['status']
  stepId?: string
  nodeId?: string
  stepKind?: RunStep['kind']
  stepStatus?: RunStep['status']
  /** Gate verdict, when the step is a gate. */
  gatePass?: boolean
  detail?: string
}

/**
 * Derive the audit events a RunState implies that have not been emitted yet. `seenSteps` tracks step ids
 * already written (mutated in place). `phase` distinguishes a fresh start/resume from a terminal flush so the
 * right lifecycle event is emitted. Deterministic: caller supplies the timestamp.
 */
export function deriveRunAuditEvents(
  state: RunState,
  seenSteps: Set<string>,
  timestamp: string,
  opts: { emitStarted?: boolean } = {},
): RunAuditEvent[] {
  const base = {
    schemaVersion: 1 as const,
    runId: state.runId,
    workflowName: state.workflowName,
    actor: state.actor,
    timestamp,
    status: state.status,
  }
  const events: RunAuditEvent[] = []

  if (opts.emitStarted) {
    events.push({ ...base, event: 'run.started' })
  }

  // One event per newly-finished step (append-only, no double-counting).
  for (const step of state.steps) {
    if (step.status === 'running' || seenSteps.has(step.id)) continue
    seenSteps.add(step.id)
    events.push({
      ...base,
      event: 'step',
      stepId: step.id,
      nodeId: step.nodeId,
      stepKind: step.kind,
      stepStatus: step.status,
      gatePass: step.gateDecision ? step.gateDecision.pass : undefined,
      detail: step.error ?? step.gateDecision?.reason,
    })
  }

  if (state.status === 'awaiting_approval' && state.pendingApproval) {
    const key = `approval-req:${state.pendingApproval.stepId}`
    if (!seenSteps.has(key)) {
      seenSteps.add(key)
      events.push({
        ...base,
        event: 'approval.requested',
        stepId: state.pendingApproval.stepId,
        nodeId: state.pendingApproval.nodeId,
        detail: state.pendingApproval.question,
      })
    }
  }

  if (state.status === 'completed') events.push({ ...base, event: 'run.completed' })
  else if (state.status === 'failed') events.push({ ...base, event: 'run.failed', detail: state.error })
  else if (state.status === 'cancelled') events.push({ ...base, event: 'run.cancelled' })

  return events
}
