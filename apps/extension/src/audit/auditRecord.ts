// Phase 3 — the append-only audit record. Pure: builds and serializes records;
// the store (auditStore.ts) owns the file I/O.
//
// One record PER EVALUATOR per run, denormalized with the overall gate decision
// so the trace can be filtered fast ("show me every run that the gate blocked").
// Shape mirrors the harvested orka run/step/audit columns so a future swap to a
// server-side store is a storage change, not a schema change.

import type { EvalRunResult, GateDecision } from '../eval/types'

export interface AuditRecord {
  schemaVersion: 1
  runId: string
  evalId: string
  timestamp: string // ISO8601
  /** SdlcStep or 'governance' for per-agent governance checks. */
  step: string
  agentId?: string
  evaluator: string
  score: number | null
  threshold: number | null
  pass: boolean
  gateDecision: 'pass' | 'fail'
  gateReason?: string
  actor: string
  source: 'extension' | 'ado'
  tokensIn: number
  tokensOut: number
  reportUrl?: string
  projectEndpoint: string
}

export interface BuildAuditInput {
  result: EvalRunResult
  decision: GateDecision
  step: string
  actor: string
  source: 'extension' | 'ado'
  projectEndpoint: string
  /** ISO timestamp — passed in so the builder stays deterministic/testable. */
  timestamp: string
  agentId?: string
}

/**
 * Expand a completed run + gate decision into one AuditRecord per evaluator.
 * Token usage is recorded on the first record only (it's a per-run total) so
 * sums over the log don't double-count.
 */
export function buildAuditRecords(input: BuildAuditInput): AuditRecord[] {
  const { result, decision } = input
  const overall: 'pass' | 'fail' = decision.pass ? 'pass' : 'fail'

  return decision.perEvaluator.map((d, i) => ({
    schemaVersion: 1,
    runId: result.runId,
    evalId: result.evalId,
    timestamp: input.timestamp,
    step: input.step,
    agentId: input.agentId,
    evaluator: d.evaluator,
    score: d.score,
    threshold: d.threshold,
    pass: d.pass,
    gateDecision: overall,
    gateReason: decision.reason,
    actor: input.actor,
    source: input.source,
    tokensIn: i === 0 ? result.usage.tokensIn : 0,
    tokensOut: i === 0 ? result.usage.tokensOut : 0,
    reportUrl: result.reportUrl,
    projectEndpoint: input.projectEndpoint,
  }))
}

/** Serialize one record as a single JSONL line (no trailing newline). */
export function toJsonl(record: AuditRecord): string {
  return JSON.stringify(record)
}

/** Parse one JSONL line back into a record (tolerant — returns null on bad line). */
export function fromJsonl(line: string): AuditRecord | null {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }
  try {
    return JSON.parse(trimmed) as AuditRecord
  } catch {
    return null
  }
}
