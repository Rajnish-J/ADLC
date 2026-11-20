'use client'

// Pick the harness a run executes in — only harnesses installed in your online VS Code windows (and allowed by the
// project) are listed, each with its version, detail tier and the windows that have it. Shared by the Start dialog
// and Settings.

import Link from 'next/link'
import { Bot, Laptop, MonitorOff } from 'lucide-react'
import { HARNESS_TIER_LABELS, type ClientPresence, type HarnessTier, type StartableHarness } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'

const TIER_VARIANT: Record<HarnessTier, 'success' | 'secondary' | 'outline'> = { full: 'success', tools: 'secondary', files: 'outline' }

const TIER_HELP: Record<HarnessTier, string> = {
  full: 'Every step, agent, skill, tool call and file edit is reported live.',
  tools: 'Steps, plans, approvals and summaries are reported; individual tool calls are not.',
  files: 'The run is checkpointed through files; the prompt is copied for you to paste.',
}

/** Badge for a harness's detail tier, with an explanation on hover. */
export function HarnessTierBadge({ tier }: { tier: HarnessTier }) {
  return (
    <UI.Tooltip>
      <UI.TooltipTrigger asChild>
        <span>
          <UI.Badge variant={TIER_VARIANT[tier]}>{HARNESS_TIER_LABELS[tier]}</UI.Badge>
        </span>
      </UI.TooltipTrigger>
      <UI.TooltipContent className="max-w-64">{TIER_HELP[tier]}</UI.TooltipContent>
    </UI.Tooltip>
  )
}

export function windowName(c: ClientPresence): string {
  const ws = c.workspace
  const repo = ws?.remoteUrl?.split('/').pop()?.replace(/\.git$/, '')
  return ws?.name || repo || `VS Code ${c.clientId.slice(0, 6)}`
}

/** What to show when no VS Code window is online. */
export function NoVsCode({ onRetry }: { onRetry?: () => void }) {
  return (
    <UI.Alert>
      <MonitorOff />
      <UI.AlertTitle>No VS Code window is connected</UI.AlertTitle>
      <UI.AlertDescription>
        <span>
          Open your project&apos;s repository in VS Code, run <span className="font-medium text-foreground">SDLC Platform: Connect to the SDLC Platform…</span>{' '}
          and paste an access token from{' '}
          <Link href="/settings/vscode" className="underline underline-offset-4">
            Settings → VS Code
          </Link>
          . Its installed harnesses (Copilot, Claude Code, Codex…) appear here within a minute.
        </span>
        {onRetry ? (
          <UI.Button variant="link" size="sm" className="h-auto p-0" onClick={onRetry}>
            Check again
          </UI.Button>
        ) : null}
      </UI.AlertDescription>
    </UI.Alert>
  )
}

interface HarnessPickerProps {
  harnesses: StartableHarness[]
  clients: ClientPresence[]
  value: string | null
  onChange: (engine: string) => void
  disabled?: boolean
}

export default function HarnessPicker({ harnesses, clients, value, onChange, disabled }: HarnessPickerProps) {
  const names = new Map(clients.map((c) => [c.clientId, windowName(c)]))
  return (
    <div role="radiogroup" aria-label="Harness" className="grid gap-2 sm:grid-cols-2">
      {harnesses.map((h) => {
        const selected = h.engine === value
        return (
          <button
            key={h.engine}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(h.engine)}
            className={UI.cn(
              'flex flex-col gap-1.5 rounded-lg border p-3 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50',
            )}
          >
            <span className="flex items-center gap-2">
              <Bot className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-medium">{h.label}</span>
              {h.version ? <span className="text-xs text-muted-foreground">v{h.version}</span> : null}
              <span className="ml-auto">
                <HarnessTierBadge tier={h.tier} />
              </span>
            </span>
            <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
              <Laptop className="size-3 shrink-0" />
              {h.clientIds.map((id) => names.get(id) ?? id.slice(0, 6)).join(', ')}
            </span>
          </button>
        )
      })}
    </div>
  )
}
