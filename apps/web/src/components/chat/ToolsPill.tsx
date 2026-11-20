'use client'

// "Tools N": what the picked assistant may use this turn. Reads and changes are listed separately; each can be
// switched off, and tools the user's role (or the tool mode) rules out are shown greyed with the reason.

import { Lock } from 'lucide-react'
import type { ChatToolInfo } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'

interface Props {
  tools: ChatToolInfo[]
  disabled: string[]
  onToggle: (name: string, on: boolean) => void
}

/** Drafting and question tools are part of how an assistant works — not switchable. */
const FIXED = new Set(['update_draft', 'ask_user', 'handoff', 'load_workflow_into_draft', 'load_agent_into_draft', 'load_skill_into_draft'])

function Group({ title, rows, disabled, onToggle }: { title: string; rows: ChatToolInfo[]; disabled: string[]; onToggle: Props['onToggle'] }) {
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      {rows.map((t) => {
        const fixed = FIXED.has(t.name)
        const on = t.available && !disabled.includes(t.name)
        return (
          <label
            key={t.name}
            className={UI.cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm', t.available ? 'cursor-pointer hover:bg-muted' : 'opacity-60')}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{t.label}</span>
              {!t.available && t.reason ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="size-3" />
                  {t.reason}
                </span>
              ) : null}
            </span>
            <UI.Switch size="sm" checked={on} disabled={!t.available || fixed} onCheckedChange={(v) => onToggle(t.name, v)} aria-label={t.label} />
          </label>
        )
      })}
    </div>
  )
}

export default function ToolsPill({ tools, disabled, onToggle }: Props) {
  const active = tools.filter((t) => t.available && !disabled.includes(t.name)).length
  const reads = tools.filter((t) => t.access === 'read')
  const writes = tools.filter((t) => t.access === 'write')
  return (
    <UI.Popover>
      <UI.PopoverTrigger asChild>
        <UI.Button variant="secondary" size="sm" className="h-8 gap-2 rounded-full px-3 text-xs" aria-label={`${active} tools`}>
          Tools
          <span className="tabular-nums text-muted-foreground">{active}</span>
        </UI.Button>
      </UI.PopoverTrigger>
      <UI.PopoverContent align="start" side="top" className="w-80 p-1.5">
        <div className="max-h-[min(28rem,60vh)] overflow-y-auto">
          <Group title="Look up" rows={reads} disabled={disabled} onToggle={onToggle} />
          <Group title="Change — asks for your approval" rows={writes} disabled={disabled} onToggle={onToggle} />
          {tools.length === 0 ? <p className="px-2 py-3 text-sm text-muted-foreground">No tools.</p> : null}
        </div>
      </UI.PopoverContent>
    </UI.Popover>
  )
}
