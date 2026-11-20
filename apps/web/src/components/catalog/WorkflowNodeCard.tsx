'use client'

// One workflow step as drawn on a canvas — shared by the read-only canvas (WorkflowCanvas) and the editor, so a
// step looks the same in both. The kind sets the accent; an agent step with no agent is drawn as a dashed
// placeholder. On a run's flow it also carries the step's live status (ring, dot, check). Must render inside a React
// Flow node (it draws the connection handles).

import type { JSX } from 'react'
import { Handle, Position } from '@xyflow/react'
import { AlertTriangle, Check, CircleAlert, X } from 'lucide-react'
import { harnessLabel } from '@sdlc/contracts'
import { NODE_HEIGHT, NODE_WIDTH, type RunMapStatus, type SpecNodeKind } from '@sdlc/core'
import { cn } from '@/lib/utils'

export const KIND_STYLE: Record<SpecNodeKind, { label: string; accent: string; swatch: string }> = {
  trigger: { label: 'Trigger', accent: 'border-l-primary', swatch: 'bg-primary' },
  agent: { label: 'Agent', accent: 'border-l-status-ready', swatch: 'bg-status-ready' },
  gate: { label: 'Gate', accent: 'border-l-warning', swatch: 'bg-warning' },
  approval: { label: 'Approval', accent: 'border-l-status-in-review', swatch: 'bg-status-in-review' },
  condition: { label: 'Condition', accent: 'border-l-status-draft', swatch: 'bg-status-draft' },
  'set-variable': { label: 'Set variable', accent: 'border-l-status-draft', swatch: 'bg-status-draft' },
  goto: { label: 'Go to', accent: 'border-l-status-draft', swatch: 'bg-status-draft' },
  end: { label: 'End', accent: 'border-l-success', swatch: 'bg-success' },
}

/** How a step looks on a run's flow (the run page): where the run is, what finished, what stopped. */
const STATUS_RING: Partial<Record<RunMapStatus, string>> = {
  running: 'ring-2 ring-primary ring-offset-1 ring-offset-background shadow-md',
  waiting: 'ring-2 ring-warning ring-offset-1 ring-offset-background shadow-md',
  failed: 'ring-2 ring-destructive ring-offset-1 ring-offset-background',
  pending: 'opacity-60',
  queued: 'opacity-60',
  skipped: 'opacity-40',
}

function StatusMark({ status }: { status: RunMapStatus }): JSX.Element | null {
  switch (status) {
    case 'running':
      return (
        <span className="relative flex size-2 shrink-0" title="In progress" aria-label="In progress">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
      )
    case 'waiting':
      return (
        <span className="rounded-sm bg-warning/15 px-1 text-[9px] leading-3.5 font-medium text-warning-foreground dark:text-warning" title="Waiting for you">
          Waiting
        </span>
      )
    case 'done':
      return <Check className="size-3.5 shrink-0 text-success" aria-label="Done" />
    case 'failed':
      return <X className="size-3.5 shrink-0 text-destructive" aria-label="Stopped" />
    default:
      return null
  }
}

const HANDLE = '!size-2 !border-0 !bg-muted-foreground'
const EDIT_HANDLE = '!size-3 !border-2 !border-background !bg-primary'

export interface WorkflowNodeCardProps {
  kind: SpecNodeKind
  label: string
  subtitle?: string
  /** The agent step's agent slug; an agent step without one is drawn as a placeholder. */
  agentId?: string
  /** The harness an agent step is pinned to. */
  harness?: string
  selected?: boolean
  /** The worst problem with the step (editor only), shown as an icon with the message as its tooltip. */
  issue?: { level: 'error' | 'warning'; message: string }
  /** Bigger, primary-coloured handles so they are easy to grab (editor). */
  editable?: boolean
  /** The step's live status on a run's flow; omitted on the workflow page and in the editor. */
  status?: RunMapStatus
}

export function WorkflowNodeCard({ kind, label, subtitle, agentId, harness, selected, issue, editable, status }: WorkflowNodeCardProps): JSX.Element {
  const style = KIND_STYLE[kind]
  const unassigned = kind === 'agent' && !agentId
  const line = unassigned ? 'No agent assigned' : subtitle
  return (
    <div
      className={cn(
        'flex flex-col justify-center rounded-lg border border-l-4 bg-card px-3 shadow-xs transition-shadow',
        style.accent,
        unassigned && 'border-dashed bg-card/60',
        selected && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
        status && STATUS_RING[status],
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      title={line ? `${label}\n${line}` : label}
    >
      {kind !== 'trigger' ? <Handle type="target" position={Position.Left} className={editable ? EDIT_HANDLE : HANDLE} /> : null}
      <span className="flex items-center justify-between gap-1">
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{style.label}</span>
        <span className="flex min-w-0 items-center gap-1">
          {status ? <StatusMark status={status} /> : null}
          {kind === 'agent' && harness ? (
            <span className="max-w-[96px] truncate rounded-sm border px-1 text-[9px] leading-3.5 text-muted-foreground" title={`Runs in ${harnessLabel(harness)}`}>
              {harnessLabel(harness)}
            </span>
          ) : null}
          {issue ? (
            <span role="img" title={issue.message} aria-label={issue.message} className="shrink-0">
              {issue.level === 'error' ? (
                <CircleAlert className="size-3.5 text-destructive" />
              ) : (
                <AlertTriangle className="size-3.5 text-warning-foreground dark:text-warning" />
              )}
            </span>
          ) : null}
        </span>
      </span>
      <span className="truncate text-xs font-medium text-card-foreground">{label}</span>
      {line ? <span className={cn('truncate text-[10px]', unassigned ? 'text-warning-foreground italic dark:text-warning' : 'text-muted-foreground')}>{line}</span> : null}
      {kind !== 'end' ? <Handle type="source" position={Position.Right} className={editable ? EDIT_HANDLE : HANDLE} /> : null}
    </div>
  )
}
