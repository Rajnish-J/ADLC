// Live run log/audit drawer shown alongside the read-only canvas while a run is active or has
// finished. Sourced entirely from the RunState already pushed to the webview via `render`/
// `runUpdate` — no new data plumbing, just a chronological view of `RunState.steps`.

import type { JSX } from 'react'
import { useState } from 'react'
import type { RunState, RunStep } from '../../runtime/port'
import { statusGlyph } from './overlay'
import { vscode } from './vscodeApi'

interface Props {
  runState: RunState
  onClose: () => void
}

function elapsed(step: RunStep): string {
  const end = step.finishedAt ?? Date.now()
  const ms = end - step.startedAt
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function currentStep(run: RunState): RunStep | undefined {
  return run.steps.find((s) => s.status === 'running') ?? run.steps[run.steps.length - 1]
}

function StepRow({ step }: { step: RunStep }): JSX.Element {
  const [expanded, setExpanded] = useState(step.status === 'running')
  const hasDetail = !!(step.output || step.error || step.gateDecision || step.activity?.thought)
  return (
    <div className={`run-log__step run-log__step--${step.status}`}>
      <button
        className="run-log__step-header"
        onClick={() => hasDetail && setExpanded((e) => !e)}
        disabled={!hasDetail}
      >
        <span className="run-log__step-glyph">{statusGlyph(step.status)}</span>
        <span className="run-log__step-label">{step.label}</span>
        <span className="run-log__step-time">{elapsed(step)}</span>
        {hasDetail && <span className="run-log__step-caret">{expanded ? '▾' : '▸'}</span>}
      </button>
      {expanded && hasDetail && (
        <div className="run-log__step-detail">
          {step.gateDecision && (
            <div className={`run-log__gate run-log__gate--${step.gateDecision.pass ? 'pass' : 'fail'}`}>
              Gate {step.gateDecision.pass ? 'PASS' : 'BLOCKED'} — {step.gateDecision.reason}
            </div>
          )}
          {step.error && <div className="run-log__error">{step.error}</div>}
          {step.status === 'running' && step.activity?.thought && (
            <div className="run-log__activity">
              <div className="run-log__activity-label">
                Live · ~{step.activity.liveTokensOut ?? 0} tokens
              </div>
              <pre className="run-log__activity-thought">{step.activity.thought}</pre>
            </div>
          )}
          {step.output && <pre className="run-log__output">{step.output}</pre>}
        </div>
      )}
    </div>
  )
}

/** Inline approve/reject affordance for a paused run, showing the agent's generated plan. */
function ApprovalPanel({ runState }: { runState: RunState }): JSX.Element | null {
  const pending = runState.pendingApproval
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  if (!pending) return null

  const decide = (approve: boolean) => {
    setBusy(true)
    vscode.postMessage({
      type: approve ? 'approveRun' : 'rejectRun',
      runId: runState.runId,
      comment: comment.trim() || undefined,
    })
  }

  return (
    <div className="run-log__approval">
      {pending.plan && <pre className="run-log__plan">{pending.plan}</pre>}
      <input
        className="run-log__comment"
        type="text"
        placeholder="Optional comment…"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        disabled={busy}
      />
      <div className="run-log__approval-actions">
        <button className="run-log__approve-btn" onClick={() => decide(true)} disabled={busy}>
          ✓ Approve
        </button>
        <button className="run-log__reject-btn" onClick={() => decide(false)} disabled={busy}>
          ✕ Reject
        </button>
      </div>
    </div>
  )
}

export function RunLogPanel({ runState, onClose }: Props): JSX.Element {
  const active = currentStep(runState)
  const total = runState.steps.length

  return (
    <div className="run-log">
      <div className="run-log__header">
        <span className="run-log__title">Run Log</span>
        <button className="run-log__close" onClick={onClose} title="Hide run log">✕</button>
      </div>

      <div className={`run-log__banner run-log__banner--${runState.status}`}>
        {runState.status === 'running' && active ? (
          <>
            <span className="run-log__banner-pulse" />
            Running: {active.label} (step {active.seq} of {total})
          </>
        ) : runState.status === 'awaiting_approval' ? (
          `⏸ Awaiting approval — ${runState.pendingApproval?.question ?? 'a step is paused'}`
        ) : runState.status === 'completed' ? (
          `✓ Completed — ${total} step(s)`
        ) : runState.status === 'failed' ? (
          `✕ Failed${runState.error ? ` — ${runState.error}` : ''}`
        ) : runState.status === 'cancelled' ? (
          '⏹ Cancelled'
        ) : (
          'Queued…'
        )}
      </div>

      {runState.status === 'awaiting_approval' && <ApprovalPanel runState={runState} />}

      <div className="run-log__steps">
        {runState.steps.length === 0 && <div className="run-log__empty">Waiting for the first step…</div>}
        {runState.steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </div>

      <div className="run-log__footer">
        <button className="run-log__audit-btn" onClick={() => vscode.postMessage({ type: 'openRunAudit' })}>
          View full audit log
        </button>
      </div>
    </div>
  )
}
