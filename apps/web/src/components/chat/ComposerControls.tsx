'use client'

// The composer's small controls: tool mode (Auto / Read-only / Ask every time), the model picker, the
// context-usage ring and the project chip.

import { Check, ChevronDown, Cloud, FolderKanban, ShieldCheck, Wrench, X } from 'lucide-react'
import { CHAT_TOOL_MODE_LABELS, CHAT_TOOL_MODES, type ChatModel, type ChatToolMode, type ProjectSummary } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'

const pill = 'h-8 gap-1.5 rounded-full px-2.5 text-xs'

export function ToolModeDropdown({ value, onChange }: { value: ChatToolMode; onChange: (mode: ChatToolMode) => void }) {
  return (
    <UI.DropdownMenu>
      <UI.DropdownMenuTrigger asChild>
        <UI.Button variant="ghost" size="sm" className={pill} aria-label={`Tool mode: ${CHAT_TOOL_MODE_LABELS[value].label}`}>
          {value === 'read-only' ? <ShieldCheck className="size-3.5" /> : <Wrench className="size-3.5" />}
          <span>{CHAT_TOOL_MODE_LABELS[value].label}</span>
          <ChevronDown className="size-3 opacity-60" />
        </UI.Button>
      </UI.DropdownMenuTrigger>
      <UI.DropdownMenuContent align="start" side="top" className="w-72">
        {CHAT_TOOL_MODES.map((mode) => (
          <UI.DropdownMenuItem key={mode} className="cursor-pointer items-start gap-2" onSelect={() => onChange(mode)}>
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{CHAT_TOOL_MODE_LABELS[mode].label}</span>
              <span className="text-xs text-muted-foreground">{CHAT_TOOL_MODE_LABELS[mode].description}</span>
            </span>
            {mode === value ? <Check className="ml-auto mt-0.5 size-3.5 shrink-0" /> : null}
          </UI.DropdownMenuItem>
        ))}
      </UI.DropdownMenuContent>
    </UI.DropdownMenu>
  )
}

export function SelectModel({ models, value, onChange }: { models: ChatModel[]; value: string | null; onChange: (id: string) => void }) {
  const current = models.find((m) => m.id === value) ?? models[0]
  if (!current) return null
  return (
    <UI.DropdownMenu>
      <UI.DropdownMenuTrigger asChild disabled={models.length < 2}>
        <UI.Button variant="ghost" size="sm" className={UI.cn(pill, 'disabled:opacity-100')} aria-label={`Model: ${current.label}`}>
          <Cloud className="size-3.5 text-primary" />
          <span className="max-w-32 truncate">{current.label}</span>
          {models.length > 1 ? <ChevronDown className="size-3 opacity-60" /> : null}
        </UI.Button>
      </UI.DropdownMenuTrigger>
      <UI.DropdownMenuContent align="end" side="top">
        <UI.DropdownMenuLabel className="text-xs text-muted-foreground">Azure OpenAI</UI.DropdownMenuLabel>
        {models.map((m) => (
          <UI.DropdownMenuItem key={m.id} className="cursor-pointer gap-2" onSelect={() => onChange(m.id)}>
            <span className="text-sm">{m.label}</span>
            <span className="text-xs text-muted-foreground">{Math.round(m.contextWindow / 1000)}k</span>
            {m.id === current.id ? <Check className="ml-auto size-3.5" /> : null}
          </UI.DropdownMenuItem>
        ))}
      </UI.DropdownMenuContent>
    </UI.DropdownMenu>
  )
}

/** How full the model's context window is after the latest answer. */
export function ContextUsageRing({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  const r = 7
  const c = 2 * Math.PI * r
  const tone = pct >= 85 ? 'text-destructive' : pct >= 60 ? 'text-warning' : 'text-primary'
  return (
    <UI.Tooltip>
      <UI.TooltipTrigger asChild>
        <span className="flex h-8 items-center gap-1.5 px-1.5 text-xs text-muted-foreground tabular-nums" aria-label={`Context ${pct}% used`}>
          {pct}%
          <svg viewBox="0 0 18 18" className="size-4 -rotate-90">
            <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2" className="stroke-muted" />
            <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2" strokeLinecap="round" className={UI.cn('stroke-current', tone)} strokeDasharray={c} strokeDashoffset={c - (c * pct) / 100} />
          </svg>
        </span>
      </UI.TooltipTrigger>
      <UI.TooltipContent>
        {used.toLocaleString()} of {total.toLocaleString()} tokens in context{pct >= 85 ? ' — start a new chat soon' : ''}
      </UI.TooltipContent>
    </UI.Tooltip>
  )
}

export function ProjectChip({
  projects,
  value,
  onChange,
  required,
}: {
  projects: ProjectSummary[]
  value: string | null
  onChange: (key: string | null) => void
  /** The assistant works inside one project. */
  required: boolean
}) {
  const current = projects.find((p) => p.key === value)
  return (
    <UI.DropdownMenu>
      <UI.DropdownMenuTrigger asChild>
        <UI.Button
          variant="ghost"
          size="sm"
          className={UI.cn(pill, required && !current && 'text-warning hover:text-warning')}
          aria-label={current ? `Project: ${current.name}` : 'Pick a project'}
        >
          <FolderKanban className="size-3.5" />
          <span className="max-w-28 truncate">{current ? current.key : required ? 'Pick a project' : 'All projects'}</span>
          <ChevronDown className="size-3 opacity-60" />
        </UI.Button>
      </UI.DropdownMenuTrigger>
      <UI.DropdownMenuContent align="start" side="top" className="w-64">
        <UI.DropdownMenuLabel className="text-xs text-muted-foreground">Project</UI.DropdownMenuLabel>
        <div className="max-h-72 overflow-y-auto">
          {projects.map((p) => (
            <UI.DropdownMenuItem key={p.key} className="cursor-pointer gap-2" onSelect={() => onChange(p.key)}>
              <UI.Badge variant="outline" className="font-mono text-[10px]">
                {p.key}
              </UI.Badge>
              <span className="truncate text-sm">{p.name}</span>
              {p.key === value ? <Check className="ml-auto size-3.5 shrink-0" /> : null}
            </UI.DropdownMenuItem>
          ))}
        </div>
        {value ? (
          <>
            <UI.DropdownMenuSeparator />
            <UI.DropdownMenuItem className="cursor-pointer gap-2 text-muted-foreground" onSelect={() => onChange(null)}>
              <X className="size-3.5" />
              No project
            </UI.DropdownMenuItem>
          </>
        ) : null}
      </UI.DropdownMenuContent>
    </UI.DropdownMenu>
  )
}
