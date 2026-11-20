'use client'

// How tool calls show up in the conversation: a compact row per lookup (expand for details), an Approve /
// Reject card for every change, a hand-off card, a draft-updated row and the "submitted" note.

import { useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Ban, Check, CheckCircle2, ChevronRight, CircleAlert, FilePenLine, ShieldQuestion, X } from 'lucide-react'
import type { ChatAgentSummary, DraftSubmittedData, HandoffInput } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { agentIcon, draftHref, type ToolPart } from './chatHelpers'

const json = (v: unknown) => JSON.stringify(v, null, 2)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Values for the approval summary: ids shortened (the assistant names the person or item in its reply). */
const show = (v: unknown): string => (typeof v === 'string' ? (UUID.test(v) ? `${v.slice(0, 8)}…` : v) : JSON.stringify(v))

/** The input as "key: value" lines, for the approval card. */
function Summary({ input }: { input: unknown }) {
  if (!input || typeof input !== 'object') return null
  const rows = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== '')
  if (rows.length === 0) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 truncate font-mono">{show(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

function failed(output: unknown): string | null {
  if (output && typeof output === 'object' && (output as { ok?: unknown }).ok === false) {
    return String((output as { error?: unknown }).error ?? 'Failed')
  }
  return null
}

export function ToolRow({ part, label }: { part: ToolPart; label: string }) {
  const [open, setOpen] = useState(false)
  const running = part.state === 'input-streaming' || part.state === 'input-available' || part.state === 'approval-responded'
  const error = part.state === 'output-error' ? (part.errorText ?? 'Failed') : failed(part.output)
  const denied = part.state === 'output-denied'
  return (
    <UI.Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-muted/20 text-xs">
      <UI.CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        {running ? (
          <UI.Spinner className="size-3.5" />
        ) : denied ? (
          <Ban className="size-3.5 text-muted-foreground" />
        ) : error ? (
          <CircleAlert className="size-3.5 text-destructive" />
        ) : (
          <Check className="size-3.5 text-success" />
        )}
        <span className="font-medium">{label}</span>
        {denied ? <span className="text-muted-foreground">— rejected</span> : null}
        {error ? <span className="truncate text-destructive">— {error}</span> : null}
        <ChevronRight className={UI.cn('ml-auto size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </UI.CollapsibleTrigger>
      <UI.CollapsibleContent>
        <div className="flex flex-col gap-2 border-t px-2.5 py-2">
          <pre className="max-h-48 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] whitespace-pre-wrap">{json(part.input ?? {})}</pre>
          {part.output !== undefined ? (
            <pre className="max-h-64 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] whitespace-pre-wrap">{json(part.output)}</pre>
          ) : null}
        </div>
      </UI.CollapsibleContent>
    </UI.Collapsible>
  )
}

export function ApprovalCard({
  part,
  label,
  active,
  onDecide,
}: {
  part: ToolPart
  label: string
  active: boolean
  onDecide: (approved: boolean, reason?: string) => void
}) {
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-3">
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <ShieldQuestion className="size-4 text-primary" />
        Approve: {label}?
      </span>
      <Summary input={part.input} />
      {rejecting ? (
        <UI.Input
          autoFocus
          value={reason}
          placeholder="What should change? (optional)"
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onDecide(false, reason.trim() || undefined)}
          className="h-8 bg-background text-sm"
        />
      ) : null}
      <div className="flex justify-end gap-2">
        {rejecting ? (
          <UI.Button size="sm" variant="outline" disabled={!active} onClick={() => onDecide(false, reason.trim() || undefined)}>
            <X className="size-3.5" />
            Reject
          </UI.Button>
        ) : (
          <UI.Button size="sm" variant="ghost" disabled={!active} onClick={() => setRejecting(true)}>
            Reject
          </UI.Button>
        )}
        <UI.Button size="sm" disabled={!active} onClick={() => onDecide(true)}>
          <Check className="size-3.5" />
          Approve
        </UI.Button>
      </div>
    </div>
  )
}

export function HandoffCard({
  input,
  agents,
  done,
  active,
  onAccept,
}: {
  input: HandoffInput | undefined
  agents: ChatAgentSummary[]
  done: boolean
  active: boolean
  onAccept: () => void
}) {
  const target = agents.find((a) => a.name === input?.agent)
  const Icon = agentIcon(target?.icon)
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 shadow-xs">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{target ? `${target.label} specialist` : 'A specialist'} can take this</span>
        {input?.brief ? <span className="line-clamp-2 text-xs text-muted-foreground">{input.brief}</span> : null}
      </span>
      {done ? (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3.5 text-success" />
          Switched
        </span>
      ) : (
        <UI.Button size="sm" disabled={!active || !target} onClick={onAccept}>
          Continue
          <ArrowRight className="size-3.5" />
        </UI.Button>
      )}
    </div>
  )
}

export function DraftUpdateRow({ part, noun, onReview }: { part: ToolPart; noun: string; onReview: () => void }) {
  const out = part.output as { errors?: string[]; ready?: boolean; mode?: string } | undefined
  const running = part.state !== 'output-available' && part.state !== 'output-error'
  const errors = out?.errors?.length ?? 0
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed bg-muted/20 px-2.5 py-1.5 text-xs">
      {running ? <UI.Spinner className="size-3.5" /> : <FilePenLine className="size-3.5 text-primary" />}
      <span className="font-medium">{running ? `Updating the ${noun} draft…` : `Updated the ${noun} draft`}</span>
      {!running && out?.mode && out.mode !== 'create' ? <span className="text-muted-foreground">({out.mode})</span> : null}
      {!running && errors > 0 ? <span className="text-warning">{errors} to fix</span> : null}
      {!running && out?.ready ? <span className="text-success">ready</span> : null}
      {!running ? (
        <UI.Button size="xs" variant="ghost" className="ml-auto h-6 px-2" onClick={onReview}>
          Review
        </UI.Button>
      ) : null}
    </div>
  )
}

export function DraftSubmittedCard({ data }: { data: DraftSubmittedData }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-success/40 bg-success/5 px-3.5 py-2.5 text-sm">
      <CheckCircle2 className="size-4 shrink-0 text-success" />
      <span className="min-w-0 flex-1">{data.label}</span>
      <UI.Button asChild size="sm" variant="outline" className="h-7">
        <Link href={draftHref(data.ref)}>
          Open
          <ArrowRight className="size-3.5" />
        </Link>
      </UI.Button>
    </div>
  )
}
