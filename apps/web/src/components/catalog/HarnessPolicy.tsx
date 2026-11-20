'use client'

// Project owners: which harnesses this project's runs may use, and the default one. "Any installed harness" leaves
// the choice to each developer (only what is installed in their VS Code is ever offered).

import { useState } from 'react'
import { Bot } from 'lucide-react'
import { HARNESS_TIER_LABELS, harnessLabel, KNOWN_HARNESSES, readProjectSettings, type ProjectDetail } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { updateProject } from '@/service/settings.service'

export default function HarnessPolicy({ project }: { project: ProjectDetail }) {
  const current = readProjectSettings(project.settings)
  const [allowed, setAllowed] = useState<string[]>(current.allowedEngines)
  const [defaultEngine, setDefault] = useState(current.defaultEngine)
  const [saving, setSaving] = useState(false)
  const canEdit = project.permissions.includes('project.update')
  const ids = [...new Set([...KNOWN_HARNESSES.map((h) => h.id), ...current.allowedEngines, current.defaultEngine])]
  const any = allowed.length === 0
  const dirty = JSON.stringify([...allowed].sort()) !== JSON.stringify([...current.allowedEngines].sort()) || defaultEngine !== current.defaultEngine

  function toggle(id: string, on: boolean) {
    const base = any ? ids : allowed
    const next = on ? [...new Set([...base, id])] : base.filter((x) => x !== id)
    setAllowed(next.length === ids.length ? [] : next)
    if (!on && id === defaultEngine) setDefault(next[0] ?? 'copilot')
  }

  async function save() {
    setSaving(true)
    try {
      await updateProject(project.key, { settings: { defaultEngine, allowedEngines: allowed } })
      UI.toast.success('Harness settings saved')
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <UI.Card className="gap-0 py-0">
      <UI.CardHeader className="border-b py-4">
        <UI.CardTitle>Harnesses</UI.CardTitle>
        <UI.CardDescription>
          Which coding harnesses this project’s runs may use. Developers only ever see the allowed ones they have installed in VS Code.
          {canEdit ? null : ' Owners and leads can change this.'}
        </UI.CardDescription>
        {canEdit ? (
          <UI.CardAction>
            <UI.Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? <UI.Spinner /> : null} Save
            </UI.Button>
          </UI.CardAction>
        ) : null}
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-4 py-4">
        <UI.Field orientation="horizontal">
          <UI.Switch id="any-harness" disabled={!canEdit} checked={any} onCheckedChange={(on) => setAllowed(on ? [] : ids)} />
          <UI.FieldLabel htmlFor="any-harness">Allow any installed harness</UI.FieldLabel>
        </UI.Field>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {ids.map((id) => {
            const known = KNOWN_HARNESSES.find((h) => h.id === id)
            const on = any || allowed.includes(id)
            return (
              <label key={id} className={UI.cn('flex items-center gap-2 rounded-md border p-2 text-sm', any && 'opacity-60')}>
                <UI.Checkbox checked={on} disabled={any || !canEdit} onCheckedChange={(v) => toggle(id, v === true)} />
                <Bot className="size-4 text-muted-foreground" />
                <span className="flex-1 truncate">{harnessLabel(id)}</span>
                {known ? <span className="text-xs text-muted-foreground">{HARNESS_TIER_LABELS[known.tier]}</span> : null}
              </label>
            )
          })}
        </div>
        <UI.Field>
          <UI.FieldLabel>Default harness</UI.FieldLabel>
          <UI.FieldDescription>Used when a developer has not picked one in Settings.</UI.FieldDescription>
          <UI.Select value={defaultEngine} onValueChange={setDefault} disabled={!canEdit}>
            <UI.SelectTrigger className="w-60" aria-label="Default harness">
              <UI.SelectValue />
            </UI.SelectTrigger>
            <UI.SelectContent>
              {(any ? ids : allowed).map((id) => (
                <UI.SelectItem key={id} value={id}>
                  {harnessLabel(id)}
                </UI.SelectItem>
              ))}
            </UI.SelectContent>
          </UI.Select>
        </UI.Field>
      </UI.CardContent>
    </UI.Card>
  )
}
