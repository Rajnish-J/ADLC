'use client'

// Settings → Agent engine: which coding harness opens when you start work — only the ones installed in your
// connected VS Code windows are offered (GitHub Copilot, Claude Code, Codex, Roo Code, …) — and an optional model. Each project may limit the engines; the table shows the engine you'll actually get in each.
// VS Code picks the choice up from the platform while it is connected.

import { useEffect, useState } from 'react'
import { Check, Info } from 'lucide-react'
import { effectiveEngine, harnessLabel, isHarnessAllowed, startableHarnesses, type AgentEngine } from '@sdlc/contracts'
import { HarnessTierBadge, NoVsCode } from '@/components/work/HarnessPicker'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'
import SectionHeader from '../SectionHeader'

const ENGINE_HELP: Record<string, string> = {
  copilot: 'GitHub Copilot Chat in agent mode.',
  'claude-code': 'Anthropic’s Claude Code extension.',
  codex: 'OpenAI’s Codex extension.',
}

export default function EngineSection() {
  const { data: settings, error, loading, setData } = ST.useMySettings()
  const { data: projects } = ST.useProjects()
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setModel(settings?.preferences.engineModel ?? '')
  }, [settings?.preferences.engineModel])

  async function save(patch: { agentEngine?: AgentEngine | null; engineModel?: string | null }): Promise<void> {
    setSaving(true)
    try {
      setData(await ST.updatePreferences(patch))
      UI.toast.success('Agent engine saved', { description: 'VS Code picks it up while it is connected to the platform.' })
    } catch (err) {
      UI.toast.error(err instanceof ST.AppError ? err.message : 'Could not save the preference.')
    } finally {
      setSaving(false)
    }
  }

  if (error) return <UI.ErrorAlert title="Could not load your settings" message={error.message} />
  if (loading || !settings) return <UI.Skeleton className="h-64 rounded-xl" />
  const chosen = settings.preferences.agentEngine

  // Only harnesses installed in a connected VS Code window are offered; a saved choice that is no longer installed
  // stays visible (flagged) so it can be changed.
  const installed = startableHarnesses(settings.clients, null)
  const options: Array<{ id: AgentEngine | null; label: string; help: string; tier?: (typeof installed)[number]['tier'] }> = [
    { id: null, label: 'Project default', help: 'Use whatever each project sets as its default.' },
    ...installed.map((h) => ({ id: h.engine, label: h.label, help: `${ENGINE_HELP[h.engine] ?? 'Installed in your VS Code.'}${h.version ? ` v${h.version}` : ''}`, tier: h.tier })),
    ...(chosen && !installed.some((h) => h.engine === chosen)
      ? [{ id: chosen, label: harnessLabel(chosen), help: 'Not installed in any connected VS Code window right now.' }]
      : []),
  ]

  return (
    <>
      <SectionHeader title="Agent engine" description="The coding agent in your VS Code that runs your stories. Projects can limit which engines are allowed." />
      <UI.Card>
        <UI.CardHeader>
          <UI.CardTitle className="text-base">Preferred engine</UI.CardTitle>
          <UI.CardDescription>Only harnesses installed in your connected VS Code windows are listed — see the VS Code section.</UI.CardDescription>
        </UI.CardHeader>
        <UI.CardContent className="flex flex-col gap-5">
          {settings.clients.every((c) => !c.online) ? <NoVsCode /> : null}
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Preferred engine">
            {options.map((o) => {
              const active = chosen === o.id
              return (
                <button
                  key={o.id ?? 'default'}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={saving}
                  onClick={() => !active && void save({ agentEngine: o.id })}
                  className={UI.cn(
                    'flex items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted/60 disabled:opacity-60',
                    active && 'border-primary bg-primary/5 ring-1 ring-primary',
                  )}
                >
                  <span className={UI.cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', active && 'border-primary bg-primary text-primary-foreground')}>
                    {active ? <Check className="size-3" /> : null}
                  </span>
                  <span>
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {o.label}
                      {o.tier ? <HarnessTierBadge tier={o.tier} /> : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">{o.help}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <UI.Field>
            <UI.FieldLabel htmlFor="engine-model">Model (optional)</UI.FieldLabel>
            <div className="flex gap-2">
              <UI.Input id="engine-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. claude-sonnet-4-6 or gpt-5" className="max-w-sm font-mono text-sm" />
              <UI.Button
                variant="outline"
                disabled={saving || model.trim() === (settings.preferences.engineModel ?? '')}
                onClick={() => void save({ engineModel: model.trim() || null })}
              >
                {saving ? <UI.Spinner /> : null} Save model
              </UI.Button>
            </div>
            <UI.FieldDescription>Leave empty to use the engine’s own default model.</UI.FieldDescription>
          </UI.Field>
        </UI.CardContent>
      </UI.Card>

      <UI.Card>
        <UI.CardHeader>
          <UI.CardTitle className="text-base">What you get in each project</UI.CardTitle>
          <UI.CardDescription>If a project doesn’t allow your choice, its default engine is used instead.</UI.CardDescription>
        </UI.CardHeader>
        <UI.CardContent>
          {!projects ? (
            <UI.Skeleton className="h-16" />
          ) : projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">You aren’t on any project yet.</p>
          ) : (
            <UI.Table>
              <UI.TableHeader>
                <UI.TableRow>
                  <UI.TableHead>Project</UI.TableHead>
                  <UI.TableHead>Allowed engines</UI.TableHead>
                  <UI.TableHead>You get</UI.TableHead>
                </UI.TableRow>
              </UI.TableHeader>
              <UI.TableBody>
                {projects.map((p) => {
                  const engine = effectiveEngine(chosen, p.settings)
                  const blocked = chosen !== null && !isHarnessAllowed(chosen, p.settings.allowedEngines)
                  return (
                    <UI.TableRow key={p.id}>
                      <UI.TableCell className="font-medium">
                        <span className="font-mono text-xs text-muted-foreground">{p.key}</span> {p.name}
                      </UI.TableCell>
                      <UI.TableCell className="text-sm text-muted-foreground">{p.settings.allowedEngines.length ? p.settings.allowedEngines.map(harnessLabel).join(', ') : 'Any installed'}</UI.TableCell>
                      <UI.TableCell>
                        <span className="inline-flex items-center gap-1.5 text-sm">
                          {harnessLabel(engine)}
                          {blocked ? (
                            <span title={`${p.key} doesn’t allow ${harnessLabel(chosen as string)}, so its default is used.`}>
                              <Info className="size-3.5 text-warning" />
                            </span>
                          ) : null}
                        </span>
                      </UI.TableCell>
                    </UI.TableRow>
                  )
                })}
              </UI.TableBody>
            </UI.Table>
          )}
        </UI.CardContent>
      </UI.Card>
    </>
  )
}
