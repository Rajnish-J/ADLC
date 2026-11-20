'use client'

// The question a platform-driven run is waiting on, the plan up for approval, and — for whoever started the run or a
// lead (the API checks the same) — the decision.

import { useState } from 'react'
import { Check, Pause, X } from 'lucide-react'
import type { ProjectRunDetail } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { approveRun } from '@/service/harnessRun.service'

type PendingApproval = NonNullable<ProjectRunDetail['pendingApproval']>

export default function ApprovalPanel({
  projectKey,
  run,
  pending,
  canDecide,
  onDecided,
}: {
  projectKey: string
  run: ProjectRunDetail
  pending: PendingApproval
  canDecide: boolean
  onDecided: () => void
}) {
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const step = run.steps.find((s) => s.stepId === pending.stepId)
  const open = run.status === 'awaiting_approval'
  // What is being approved: the agent's plan, or (for an approval node) the latest agent's output.
  const context = pending.context ?? step?.plan ?? null
  const contextLabel =
    pending.kind === 'approval' ? `${pending.agentName ?? 'Previous step'}'s output` : `${pending.agentName ?? step?.agentName ?? 'Agent'}'s plan`

  async function decide(approve: boolean) {
    setBusy(approve ? 'approve' : 'reject')
    try {
      await approveRun(projectKey, run.id, { approve, comment: comment.trim() || undefined, stepId: pending.stepId })
      UI.toast.success(approve ? 'Approved' : 'Rejected')
      setComment('')
      onDecided()
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not record the decision')
    } finally {
      setBusy(null)
    }
  }

  return (
    <UI.Alert>
      <Pause />
      <UI.AlertTitle>Waiting for approval{step ? ` · ${step.label}` : ''}</UI.AlertTitle>
      <UI.AlertDescription className="flex flex-col gap-2">
        <span className="whitespace-pre-wrap">{pending.question}</span>
        {context ? (
          <details open className="w-full text-xs">
            <summary className="cursor-pointer text-primary">{contextLabel}</summary>
            <pre className="mt-1 max-h-72 overflow-auto rounded-md border bg-background p-2 font-mono whitespace-pre-wrap text-foreground">{context}</pre>
          </details>
        ) : null}
        {open && canDecide ? (
          <div className="flex w-full flex-col gap-2">
            <UI.Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Comment (optional)"
              rows={2}
              maxLength={2000}
              disabled={busy !== null}
              aria-label="Comment on the decision"
              className="text-sm"
            />
            <div className="flex gap-2">
              <UI.Button size="sm" onClick={() => void decide(true)} disabled={busy !== null}>
                {busy === 'approve' ? <UI.Spinner /> : <Check />} Approve
              </UI.Button>
              <UI.Button size="sm" variant="outline" onClick={() => void decide(false)} disabled={busy !== null}>
                {busy === 'reject' ? <UI.Spinner /> : <X />} Reject
              </UI.Button>
            </div>
          </div>
        ) : open ? (
          <span className="text-xs">Waiting for {run.startedBy?.displayName ?? 'whoever started it'} or a lead to decide.</span>
        ) : null}
      </UI.AlertDescription>
    </UI.Alert>
  )
}
