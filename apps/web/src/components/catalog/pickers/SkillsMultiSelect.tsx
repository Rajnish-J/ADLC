'use client'

// The skills an agent step may use, as badges plus a searchable "add skills" list. Presentational: the caller
// decides what a change does (StepSkills saves it straight away; the workflow editor keeps it until Save).

import { Check, Plus, Sparkles } from 'lucide-react'
import type { Agent } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'

interface SkillsMultiSelectProps {
  /** The project's catalog (agents and skills); only enabled skills the caller may use are offered. */
  catalog: Agent[]
  value: string[]
  onChange: (next: string[]) => void
  canEdit: boolean
  busy?: boolean
  /** Names the control for screen readers, e.g. the step label. */
  label: string
  /** Draw the badges removable (the editor), rather than only through the list. */
  removable?: boolean
}

export function SkillsMultiSelect({ catalog, value, onChange, canEdit, busy, label, removable }: SkillsMultiSelectProps) {
  const bySlug = new Map(catalog.map((s) => [s.slug, s]))
  const options = catalog.filter((s) => s.kind === 'skill' && s.enabled && s.usable)
  const toggle = (slug: string): void => onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug])

  if (!canEdit && value.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((slug) => (
        <UI.Badge key={slug} variant="outline" title={bySlug.get(slug)?.description ?? slug}>
          <Sparkles /> {bySlug.get(slug)?.name ?? slug}
          {removable && canEdit ? (
            <button
              type="button"
              className="-mr-1 ml-0.5 rounded-sm px-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => toggle(slug)}
              aria-label={`Remove ${bySlug.get(slug)?.name ?? slug}`}
              disabled={busy}
            >
              ×
            </button>
          ) : null}
        </UI.Badge>
      ))}
      {canEdit ? (
        <UI.Popover>
          <UI.PopoverTrigger asChild>
            <UI.Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy} aria-label={`Skills for ${label}`}>
              {busy ? <UI.Spinner className="size-3" /> : <Plus />} {value.length ? 'Skills' : 'Add skills'}
            </UI.Button>
          </UI.PopoverTrigger>
          <UI.PopoverContent className="w-72 p-0" align="start">
            <UI.Command>
              <UI.CommandInput placeholder="Search skills…" />
              <UI.CommandList>
                <UI.CommandEmpty>No enabled skills. Enable some on the Skills page.</UI.CommandEmpty>
                <UI.CommandGroup>
                  {options.map((s) => (
                    <UI.CommandItem key={s.slug} value={`${s.name} ${s.slug}`} onSelect={() => toggle(s.slug)} disabled={busy}>
                      <Check className={UI.cn('size-4', value.includes(s.slug) ? 'opacity-100' : 'opacity-0')} />
                      <span className="truncate">{s.name}</span>
                    </UI.CommandItem>
                  ))}
                </UI.CommandGroup>
              </UI.CommandList>
            </UI.Command>
          </UI.PopoverContent>
        </UI.Popover>
      ) : null}
    </div>
  )
}
