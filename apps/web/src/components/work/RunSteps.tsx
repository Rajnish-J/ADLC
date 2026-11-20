'use client'

// One agent run's step timeline — gate verdicts with their evaluator scores, approval decisions, outputs and the
// files agents changed. Shared by the story's run list and the project's Workflow › Runs sheet.

import { Bot, Check, CircleDot, Minus, Pause, Sparkles, X } from 'lucide-react'
import { harnessLabel, type StoryRunStatus, type StoryRunStep, type StoryRunStepStatus } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import type { BadgeVariant } from '@/utils/status'
import EvaluationScores from './EvaluationScores'

export const RUN_VARIANT: Record<StoryRunStatus, BadgeVariant> = {
  requested: 'outline',
  expired: 'secondary',
  queued: 'outline',
  running: 'default',
  awaiting_approval: 'warning',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'secondary',
}

const STEP_ICON: Record<StoryRunStepStatus, { icon: typeof Check; className: string }> = {
  succeeded: { icon: Check, className: 'text-success' },
  failed: { icon: X, className: 'text-destructive' },
  running: { icon: CircleDot, className: 'text-primary animate-pulse' },
  skipped: { icon: Minus, className: 'text-muted-foreground' },
  blocked: { icon: Pause, className: 'text-warning-foreground dark:text-warning' },
}

export function runDuration(from: string, to: string | null): string {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Skills bound to and used by a step, the model, tool calls, tokens and duration. */
function StepMeta({ step: s }: { step: StoryRunStep }) {
  const used = new Map(s.skillsUsed.map((u) => [u.slug, u.evidence]))
  const skills = [...new Set([...s.skills, ...used.keys()])]
  const tokens = (s.tokensIn ?? 0) + (s.tokensOut ?? 0)
  const facts = [
    s.model,
    s.toolCalls !== null ? `${s.toolCalls} tool call${s.toolCalls === 1 ? '' : 's'}` : null,
    tokens > 0 ? `${tokens.toLocaleString()} tokens` : null,
    s.startedAt ? runDuration(s.startedAt, s.finishedAt) : null,
  ].filter(Boolean)
  if (!skills.length && !facts.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {skills.map((slug) => {
        const evidence = used.get(slug)
        return (
          <UI.Badge
            key={slug}
            variant={evidence ? 'outline' : 'secondary'}
            className={UI.cn(!evidence && 'opacity-60')}
            title={evidence ? `Used (${evidence})` : 'Available to this step, not used'}
          >
            <Sparkles /> {slug}
          </UI.Badge>
        )
      })}
      {facts.length ? <span>{facts.join(' · ')}</span> : null}
    </div>
  )
}

export default function RunSteps({ steps }: { steps: StoryRunStep[] }) {
  if (steps.length === 0) return <p className="text-xs text-muted-foreground">No steps reported yet.</p>
  return (
    <ol className="flex flex-col">
      {steps.map((s) => {
        const { icon: Icon, className } = STEP_ICON[s.status]
        return (
          <li key={s.stepId} className="flex gap-3 border-l py-1.5 pl-3">
            <Icon className={UI.cn('mt-0.5 size-4 shrink-0', className)} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="font-medium">{s.label}</span>
                <span className="text-xs text-muted-foreground">{s.kind}</span>
                {s.agentName || s.agentSlug ? (
                  <UI.Badge variant="secondary" title={s.agentSlug ?? undefined}>
                    <Bot /> {s.agentName ?? s.agentSlug}
                  </UI.Badge>
                ) : null}
                {s.engine ? (
                  <UI.Badge variant="outline" title="The harness this step ran in">
                    {harnessLabel(s.engine)}
                  </UI.Badge>
                ) : null}
                {s.gatePass !== null ? <UI.Badge variant={s.gatePass ? 'success' : 'destructive'}>{s.gatePass ? 'Gate passed' : 'Gate failed'}</UI.Badge> : null}
                {s.approval ? (
                  <UI.Badge variant={s.approval.approve ? 'success' : 'destructive'}>
                    {s.approval.approve ? 'Approved' : 'Rejected'}
                    {s.approval.actor ? ` by ${s.approval.actor}` : ''}
                  </UI.Badge>
                ) : null}
              </div>
              <StepMeta step={s} />
              {s.gatePass === false && s.gateReason ? <p className="text-xs text-muted-foreground">{s.gateReason}</p> : null}
              <EvaluationScores evaluations={s.evaluations} reportUrl={s.reportUrl} />
              {s.approval?.comment ? <p className="text-xs text-muted-foreground">“{s.approval.comment}”</p> : null}
              {s.error ? <p className="text-xs text-destructive">{s.error}</p> : null}
              {s.plan ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-primary">Plan</summary>
                  <pre className="mt-1 max-h-72 overflow-auto rounded-md border bg-background p-2 font-mono whitespace-pre-wrap">{s.plan}</pre>
                </details>
              ) : null}
              {s.output ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-primary">Output</summary>
                  <pre className="mt-1 max-h-72 overflow-auto rounded-md border bg-background p-2 font-mono whitespace-pre-wrap">{s.output}</pre>
                </details>
              ) : null}
              {s.changedFiles.length ? <p className="truncate font-mono text-xs text-muted-foreground">{s.changedFiles.join(', ')}</p> : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
