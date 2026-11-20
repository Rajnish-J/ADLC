'use client'

// What can be added to a workflow: step kinds, and the project's agents (an agent arrives as an agent step that
// is already mapped to it). Drag one onto the canvas to place it, or click it to add it to the chain after the
// selected step (or before the end).

import { useState, type DragEvent, type ReactNode } from 'react'
import { Bot, CornerDownRight, Flag, GitBranch, Plus, Search, ShieldCheck, UserCheck, Variable } from 'lucide-react'
import type { Agent } from '@sdlc/contracts'
import type { SpecNodeKind } from '@sdlc/core'
import * as UI from '@/imports/UI.imports'
import { KIND_STYLE } from '../WorkflowNodeCard'
import { PALETTE_MIME, type PalettePayload } from './editorModel'

const STEPS: Array<{ kind: SpecNodeKind; icon: ReactNode; hint: string }> = [
  { kind: 'agent', icon: <Bot />, hint: 'An agent plans, you approve, it executes' },
  { kind: 'approval', icon: <UserCheck />, hint: 'Wait for a person to approve' },
  { kind: 'gate', icon: <ShieldCheck />, hint: 'Evaluate the work; failures stop the run' },
  { kind: 'condition', icon: <GitBranch />, hint: 'Take this branch only when a check holds' },
  { kind: 'set-variable', icon: <Variable />, hint: 'Store a value for later steps' },
  { kind: 'goto', icon: <CornerDownRight />, hint: 'Jump back to an earlier step' },
  { kind: 'end', icon: <Flag />, hint: 'Finish the run' },
]

function startDrag(e: DragEvent, payload: PalettePayload): void {
  e.dataTransfer.setData(PALETTE_MIME, JSON.stringify(payload))
  e.dataTransfer.effectAllowed = 'move'
}

function PaletteItem({
  payload,
  icon,
  accent,
  title,
  hint,
  onAdd,
  disabled,
}: {
  payload: PalettePayload
  icon: ReactNode
  accent: string
  title: string
  hint: string
  onAdd: (payload: PalettePayload) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      draggable={!disabled}
      disabled={disabled}
      onDragStart={(e) => startDrag(e, payload)}
      onClick={() => onAdd(payload)}
      title={`${hint}\nDrag onto the canvas, or click to add after the selected step.`}
      className={UI.cn(
        'group flex w-full cursor-grab items-center gap-2.5 rounded-md border border-l-4 bg-card px-2.5 py-2 text-left text-sm shadow-xs transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
        accent,
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{hint}</span>
      </span>
      <Plus className="text-muted-foreground opacity-0 group-hover:opacity-100" />
    </button>
  )
}

export default function NodePalette({ catalog, onAdd, disabled }: { catalog: Agent[] | null; onAdd: (payload: PalettePayload) => void; disabled?: boolean }) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const agents = (catalog ?? []).filter((a) => a.kind === 'agent' && a.enabled && a.usable)
  const matching = q ? agents.filter((a) => `${a.name} ${a.slug} ${a.description}`.toLowerCase().includes(q)) : agents

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-3">
          <section className="flex flex-col gap-1.5" aria-labelledby="palette-steps">
            <h3 id="palette-steps" className="px-0.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Steps
            </h3>
            {STEPS.map((s) => (
              <PaletteItem
                key={s.kind}
                payload={{ kind: s.kind }}
                icon={s.icon}
                accent={KIND_STYLE[s.kind].accent}
                title={KIND_STYLE[s.kind].label}
                hint={s.hint}
                onAdd={onAdd}
                disabled={disabled}
              />
            ))}
          </section>

          <section className="flex flex-col gap-1.5" aria-labelledby="palette-agents">
            <h3 id="palette-agents" className="flex items-center justify-between px-0.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Agents
              <span className="font-normal normal-case tabular-nums">{agents.length}</span>
            </h3>
            <UI.InputGroup className="h-8">
              <UI.InputGroupAddon>
                <Search />
              </UI.InputGroupAddon>
              <UI.InputGroupInput placeholder="Search agents…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search agents" />
            </UI.InputGroup>
            {catalog === null ? (
              <>
                <UI.Skeleton className="h-11" />
                <UI.Skeleton className="h-11" />
              </>
            ) : matching.length === 0 ? (
              <p className="px-0.5 py-2 text-xs text-muted-foreground">{q ? 'No agent matches.' : 'No agents are enabled for this project.'}</p>
            ) : (
              matching.map((a) => (
                <PaletteItem
                  key={a.slug}
                  payload={{ kind: 'agent', agentSlug: a.slug }}
                  icon={<Bot />}
                  accent={KIND_STYLE.agent.accent}
                  title={a.name}
                  hint={a.description}
                  onAdd={onAdd}
                  disabled={disabled}
                />
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
