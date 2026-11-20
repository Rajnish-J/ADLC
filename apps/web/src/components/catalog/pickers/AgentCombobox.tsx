'use client'

// Pick the agent an agent step runs: a searchable list of the project's agents grouped by where they come from.
// Agents that are switched off for the project, or restricted to a higher role than yours, are listed but can't be
// picked (the API would refuse them), with the reason beside them.

import { useState } from 'react'
import { Bot, Check, ChevronsUpDown } from 'lucide-react'
import { PROJECT_ROLE_LABELS, type Agent } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'

const GROUPS: Array<{ source: Agent['source']; heading: string }> = [
  { source: 'platform', heading: 'Platform' },
  { source: 'repo', heading: 'From codebase' },
  { source: 'builtin', heading: 'Built-in' },
]

/** Why an agent can't be mapped onto a step right now, if it can't. */
export function agentUnavailableReason(agent: Agent): string | undefined {
  if (!agent.usable) return agent.requiredRole ? `${PROJECT_ROLE_LABELS[agent.requiredRole]}+ only` : 'Not available to you'
  if (!agent.enabled) return 'Off for this project'
  return undefined
}

interface AgentComboboxProps {
  /** The project's catalog (agents and skills); skills are left out. */
  catalog: Agent[]
  /** The mapped agent's slug. */
  value?: string
  /** Shown when the mapped agent isn't in the catalog any more. */
  fallbackName?: string
  onChange: (agent: Agent | null) => void
  disabled?: boolean
  className?: string
}

export function AgentCombobox({ catalog, value, fallbackName, onChange, disabled, className }: AgentComboboxProps) {
  const [open, setOpen] = useState(false)
  const agents = catalog.filter((a) => a.kind === 'agent')
  const current = value ? agents.find((a) => a.slug === value) : undefined
  const shown = current?.name ?? fallbackName ?? value

  return (
    <UI.Popover open={open} onOpenChange={setOpen}>
      <UI.PopoverTrigger asChild>
        <UI.Button variant="outline" role="combobox" aria-expanded={open} disabled={disabled} className={UI.cn('w-full justify-between font-normal', className)}>
          <span className="flex min-w-0 items-center gap-2">
            <Bot className="text-muted-foreground" />
            <span className={UI.cn('truncate', !shown && 'text-muted-foreground')}>{shown ?? 'Choose an agent'}</span>
          </span>
          <ChevronsUpDown className="opacity-50" />
        </UI.Button>
      </UI.PopoverTrigger>
      <UI.PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
        <UI.Command>
          <UI.CommandInput placeholder="Search agents…" />
          <UI.CommandList>
            <UI.CommandEmpty>No agent matches.</UI.CommandEmpty>
            {value ? (
              <UI.CommandGroup>
                <UI.CommandItem
                  value="__none no agent unassign"
                  onSelect={() => {
                    onChange(null)
                    setOpen(false)
                  }}
                >
                  <span className="text-muted-foreground">No agent</span>
                </UI.CommandItem>
              </UI.CommandGroup>
            ) : null}
            {GROUPS.map(({ source, heading }) => {
              const list = agents.filter((a) => a.source === source)
              if (list.length === 0) return null
              return (
                <UI.CommandGroup key={source} heading={heading}>
                  {list.map((a) => {
                    const reason = agentUnavailableReason(a)
                    return (
                      <UI.CommandItem
                        key={a.slug}
                        value={`${a.name} ${a.slug} ${a.description}`}
                        disabled={!!reason}
                        onSelect={() => {
                          onChange(a)
                          setOpen(false)
                        }}
                        className="items-start"
                      >
                        <Check className={UI.cn('mt-0.5 size-4', a.slug === value ? 'opacity-100' : 'opacity-0')} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium">{a.name}</span>
                            {reason ? <span className="shrink-0 text-[10px] text-muted-foreground">{reason}</span> : null}
                          </span>
                          <span className="line-clamp-2 text-xs text-muted-foreground">{a.description}</span>
                        </span>
                      </UI.CommandItem>
                    )
                  })}
                </UI.CommandGroup>
              )
            })}
          </UI.CommandList>
        </UI.Command>
      </UI.PopoverContent>
    </UI.Popover>
  )
}
