'use client'

// The assistant picker: "Default", then the specialists — icon, name and a two-line description, with a check on
// the one in use. The trigger turns into the specialist's name and accent colour once one is picked.

import { Check, ChevronDown } from 'lucide-react'
import type { ChatAgentSummary } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { agentIcon } from './chatHelpers'

interface Props {
  agents: ChatAgentSummary[]
  value: string
  onChange: (name: string) => void
  disabled?: boolean
}

function Row({ agent, selected }: { agent: ChatAgentSummary; selected: boolean }) {
  const Icon = agentIcon(agent.icon)
  return (
    <>
      <span
        className={UI.cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background',
          selected && 'border-primary/40 bg-primary/10 text-primary',
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={UI.cn('text-sm font-medium', selected && 'text-primary')}>{agent.label}</span>
        <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{agent.description}</span>
      </span>
      {selected ? <Check className="ml-auto mt-1 size-3.5 shrink-0 text-primary" /> : null}
    </>
  )
}

export default function SelectAgent({ agents, value, onChange, disabled }: Props) {
  const current = agents.find((a) => a.name === value)
  const focused = current !== undefined && current.name !== 'default'
  const Icon = agentIcon(current?.icon)
  const general = agents.filter((a) => a.name === 'default')
  const specialists = agents.filter((a) => a.name !== 'default')

  return (
    <UI.DropdownMenu>
      <UI.DropdownMenuTrigger asChild disabled={disabled}>
        <UI.Button
          variant="ghost"
          size="sm"
          className={UI.cn('h-8 gap-1.5 rounded-full px-2.5 text-xs', focused && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary')}
          aria-label={`Assistant: ${current?.label ?? 'Default'}`}
        >
          <Icon className="size-3.5" />
          <span>{current?.label ?? 'Default'}</span>
          <ChevronDown className="size-3 opacity-60" />
        </UI.Button>
      </UI.DropdownMenuTrigger>
      <UI.DropdownMenuContent align="start" side="top" className="w-80 p-1.5">
        <div className="max-h-[min(26rem,60vh)] overflow-y-auto">
          {general.map((a) => (
            <UI.DropdownMenuItem key={a.name} className="cursor-pointer items-start gap-2.5 px-2 py-2" onSelect={() => onChange(a.name)}>
              <Row agent={a} selected={a.name === value} />
            </UI.DropdownMenuItem>
          ))}
          {specialists.length ? (
            <>
              <UI.DropdownMenuSeparator />
              <UI.DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Specialists
              </UI.DropdownMenuLabel>
            </>
          ) : null}
          {specialists.map((a) => (
            <UI.DropdownMenuItem key={a.name} className="cursor-pointer items-start gap-2.5 px-2 py-2" onSelect={() => onChange(a.name)}>
              <Row agent={a} selected={a.name === value} />
            </UI.DropdownMenuItem>
          ))}
        </div>
      </UI.DropdownMenuContent>
    </UI.DropdownMenu>
  )
}
