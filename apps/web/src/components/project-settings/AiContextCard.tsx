'use client'

// Project settings → Memory → AI & context: how the project uses the AI model with its memory.
// - The Project profiler: which deployment writes the profile, whether it reads project memory, and whether runs
//   that change code propose profile updates (and after how long a quiet period).
// - Semantic search: memory found by meaning (embeddings) as well as by keywords, for runs and the Memory page.
// - Curated run context: the model writes each run a focused memory brief (one extra model call per run).

import { useEffect, useState } from 'react'
import { RefreshCw, Sparkles } from 'lucide-react'
import { PROFILE_DEBOUNCE_SECONDS, ProjectAiSettingsSchema, readProjectSettings, type PlatformEvent, type ProjectAiSettings } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { useApiResource } from '@/hooks/common/useApiResource'
import { FieldLegend, FieldSet } from '@/components/ui/field'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'
import { getAiStatus, getMemoryIndex, rebuildMemoryIndex } from '@/service/ai.service'

const DEFAULT_MODEL = '__default'

function Toggle({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint: string; checked: boolean; onChange: (on: boolean) => void; disabled: boolean }) {
  return (
    <UI.Field orientation="horizontal">
      <UI.FieldContent>
        <UI.FieldLabel htmlFor={id}>{label}</UI.FieldLabel>
        <UI.FieldDescription>{hint}</UI.FieldDescription>
      </UI.FieldContent>
      <UI.Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </UI.Field>
  )
}

function ModelSelect({ id, value, models, defaultModel, onChange, disabled }: { id: string; value: string | null; models: { id: string; label: string }[]; defaultModel: string | null; onChange: (v: string | null) => void; disabled: boolean }) {
  const defaultLabel = models.find((m) => m.id === defaultModel)?.label ?? defaultModel ?? 'the default model'
  return (
    <UI.Select value={value ?? DEFAULT_MODEL} onValueChange={(v) => onChange(v === DEFAULT_MODEL ? null : v)} disabled={disabled}>
      <UI.SelectTrigger id={id} className="w-56">
        <UI.SelectValue />
      </UI.SelectTrigger>
      <UI.SelectContent>
        <UI.SelectItem value={DEFAULT_MODEL}>Default ({defaultLabel})</UI.SelectItem>
        {models.map((m) => (
          <UI.SelectItem key={m.id} value={m.id}>
            {m.label}
          </UI.SelectItem>
        ))}
      </UI.SelectContent>
    </UI.Select>
  )
}

const memoryChanged = (key: string) => (e: PlatformEvent) => (e.type === 'memory.changed' || e.type === 'project.changed') && e.projectKey === key

export default function AiContextCard({ project, onSaved }: { project: ST.ProjectDetail; onSaved: (p: ST.ProjectDetail) => void }) {
  const stored = readProjectSettings(project.settings).ai
  const storedKey = JSON.stringify(stored)
  const [ai, setAi] = useState<ProjectAiSettings>(stored)
  const [saving, setSaving] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  useEffect(() => setAi(JSON.parse(storedKey) as ProjectAiSettings), [storedKey])
  const status = useApiResource(() => getAiStatus(), [])
  const index = useApiResource(() => getMemoryIndex(project.key), [project.key], memoryChanged(project.key))

  const canEdit = project.permissions.includes('project.update')
  const canCurate = project.permissions.includes('memory.curate')
  const dirty = JSON.stringify(ai) !== storedKey
  const valid = ProjectAiSettingsSchema.safeParse(ai).success
  const set = <K extends keyof ProjectAiSettings>(key: K, value: ProjectAiSettings[K]): void => setAi((a) => ({ ...a, [key]: value }))
  const chat = status.data?.chat
  const emb = status.data?.embeddings
  const models = chat?.models ?? []

  async function save(): Promise<void> {
    setSaving(true)
    try {
      onSaved(await ST.updateProject(project.key, { settings: { ai } }))
      UI.toast.success('AI settings saved')
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not save the AI settings.')
    } finally {
      setSaving(false)
    }
  }

  async function rebuild(): Promise<void> {
    setRebuilding(true)
    try {
      await rebuildMemoryIndex(project.key)
      UI.toast.success('Re-indexing project memory', { description: 'Every item is embedded again in the background.' })
      void index.reload()
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not rebuild the index.')
    } finally {
      setRebuilding(false)
    }
  }

  const idx = index.data
  return (
    <UI.Card className="gap-0 py-0">
      <UI.CardHeader className="border-b py-4">
        <UI.CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" /> AI &amp; context
        </UI.CardTitle>
        <UI.CardDescription>
          How the AI model works with this project’s memory: the Project profiler, semantic search, and curated run context.
          {canEdit ? '' : ' Owners and leads can change these settings.'}
        </UI.CardDescription>
        {canEdit ? (
          <UI.CardAction className="flex gap-2">
            <UI.Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => setAi(stored)}>
              Reset
            </UI.Button>
            <UI.Button size="sm" disabled={!dirty || !valid || saving} onClick={() => void save()}>
              {saving ? <UI.Spinner /> : null} Save
            </UI.Button>
          </UI.CardAction>
        ) : null}
      </UI.CardHeader>

      <UI.CardContent className="flex flex-col gap-5 py-4">
        {/* What the server has */}
        <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Chat model</span>
            {status.loading && !status.data ? (
              <UI.Skeleton className="h-5 w-24" />
            ) : chat?.enabled ? (
              <span className="font-medium">{models.find((m) => m.id === chat.defaultModel)?.label ?? chat.defaultModel}</span>
            ) : (
              <span className="text-destructive" title={chat?.reason ?? undefined}>
                Not configured
              </span>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Embedding model</span>
            {emb?.enabled ? (
              <span className="font-medium">{emb.model}</span>
            ) : (
              <span className="text-muted-foreground" title={emb?.reason ?? undefined}>
                Not configured — keyword search only
              </span>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Memory indexed</span>
            <span className="flex items-center gap-2">
              {idx ? (
                <span className="font-medium tabular-nums">
                  {idx.indexed} / {idx.total}
                  {idx.indexing ? <UI.Spinner className="ml-1.5 inline size-3" /> : null}
                </span>
              ) : (
                <UI.Skeleton className="h-5 w-16" />
              )}
              {canCurate && idx?.enabled ? (
                <UI.Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void rebuild()} disabled={rebuilding}>
                  <RefreshCw className={UI.cn(rebuilding && 'animate-spin')} /> Rebuild
                </UI.Button>
              ) : null}
            </span>
          </div>
        </div>

        <UI.FieldGroup className="gap-5">
          <FieldSet className="gap-4">
            <FieldLegend variant="label">Project profiler</FieldLegend>
            <UI.Field orientation="horizontal">
              <UI.FieldContent>
                <UI.FieldLabel htmlFor="ai-profile-model">Model</UI.FieldLabel>
                <UI.FieldDescription>The deployment that writes and updates the project profile.</UI.FieldDescription>
              </UI.FieldContent>
              <ModelSelect id="ai-profile-model" value={ai.profileModel} models={models} defaultModel={chat?.defaultModel ?? null} onChange={(v) => set('profileModel', v)} disabled={!canEdit || !chat?.enabled} />
            </UI.Field>
            <Toggle
              id="ai-profile-memory"
              label="Read project memory"
              hint="Accepted conventions, decisions, learnings and pinned items shape the profile — not only the repository."
              checked={ai.profileIncludesMemory}
              onChange={(on) => set('profileIncludesMemory', on)}
              disabled={!canEdit}
            />
            <Toggle
              id="ai-profile-auto"
              label="Propose updates after runs"
              hint="When a run that changed code completes, the profiler drafts an updated profile for a lead to review."
              checked={ai.autoProposeProfile}
              onChange={(on) => set('autoProposeProfile', on)}
              disabled={!canEdit}
            />
            <UI.Field orientation="horizontal" data-invalid={!valid}>
              <UI.FieldContent>
                <UI.FieldLabel htmlFor="ai-debounce">Wait before drafting</UI.FieldLabel>
                <UI.FieldDescription>
                  Runs that end within this window become one proposal ({PROFILE_DEBOUNCE_SECONDS.min}–{PROFILE_DEBOUNCE_SECONDS.max} s).
                </UI.FieldDescription>
              </UI.FieldContent>
              <div className="flex items-center gap-2">
                <UI.Input
                  id="ai-debounce"
                  type="number"
                  min={PROFILE_DEBOUNCE_SECONDS.min}
                  max={PROFILE_DEBOUNCE_SECONDS.max}
                  step={30}
                  value={ai.profileDebounceSeconds}
                  onChange={(e) => set('profileDebounceSeconds', Number(e.target.value) || 0)}
                  disabled={!canEdit || !ai.autoProposeProfile}
                  className="w-24"
                  aria-invalid={!valid}
                />
                <span className="text-sm text-muted-foreground">s</span>
              </div>
            </UI.Field>
          </FieldSet>

          <UI.FieldSeparator />

          <FieldSet className="gap-4">
            <FieldLegend variant="label">Finding and giving memory</FieldLegend>
            <Toggle
              id="ai-semantic"
              label="Semantic search"
              hint={
                emb?.enabled
                  ? 'Find related memory by meaning as well as keywords — for runs, the Memory page and chat. “currency precision” finds “amounts are stored in cents”.'
                  : 'Needs an embedding deployment on the server (AZURE_EMBEDDING_DEPLOYMENT). Until then, keyword search is used.'
              }
              checked={ai.semanticSearch}
              onChange={(on) => set('semanticSearch', on)}
              disabled={!canEdit}
            />
            <Toggle
              id="ai-curate"
              label="Curate run context"
              hint="Before a run starts, the model reads the task and the candidate memory and writes a focused brief (about 5–15 s and one model call per run; repeat steps reuse it). Agents can still ask for all memory."
              checked={ai.curateRunContext}
              onChange={(on) => set('curateRunContext', on)}
              disabled={!canEdit || !chat?.enabled}
            />
            <UI.Field orientation="horizontal">
              <UI.FieldContent>
                <UI.FieldLabel htmlFor="ai-curator-model">Curator model</UI.FieldLabel>
                <UI.FieldDescription>A smaller, faster deployment keeps run start-up quick.</UI.FieldDescription>
              </UI.FieldContent>
              <ModelSelect id="ai-curator-model" value={ai.curatorModel} models={models} defaultModel={chat?.defaultModel ?? null} onChange={(v) => set('curatorModel', v)} disabled={!canEdit || !chat?.enabled || !ai.curateRunContext} />
            </UI.Field>
          </FieldSet>
        </UI.FieldGroup>
      </UI.CardContent>
    </UI.Card>
  )
}
