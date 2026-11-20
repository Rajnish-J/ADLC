'use client'

// A project's link to Azure Boards (owners and org admins): which Azure DevOps organization, project and (optionally)
// area, and which work item types become stories. The area keeps a project's board to its own work items when one
// Azure DevOps project holds several products (areas); the one named like this project is suggested. Each member's assigned work items there sync into this project as their stories,
// using the organisation's Azure Git connection (it needs the Work Items (Read) scope).

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { AzureBoardsSettingsSchema, suggestAreaPath, type ProjectDetail } from '@sdlc/contracts'
import { getBoardsAreas } from '@/service/boards.service'
import OutOfAreaStories from './OutOfAreaStories'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'

interface Draft {
  enabled: boolean
  organization: string
  project: string
  /** '' = the whole Azure DevOps project. */
  areaPath: string
  types: string
}

const WHOLE_PROJECT = '__whole__'
/** `Product Hub\Synfra` → `Synfra`; the root keeps its name. */
const areaLabel = (path: string): string => (path.includes('\\') ? path.slice(path.indexOf('\\') + 1) : path)

function draftFrom(boards: ST.ProjectBoards | null): Draft {
  const s = boards?.settings
  return {
    enabled: s?.enabled ?? true,
    organization: s?.organization ?? '',
    project: s?.project ?? '',
    areaPath: s?.areaPath ?? '',
    types: (s?.workItemTypes ?? ST.DEFAULT_BOARDS_WORK_ITEM_TYPES).join(', '),
  }
}

const splitTypes = (text: string): string[] => [...new Set(text.split(',').map((t) => t.trim()).filter(Boolean))]

export default function AzureBoardsCard({ project }: { project: ProjectDetail }) {
  const canEdit = project.permissions.includes('project.update')
  const { data: boards, error: loadError, loading, setData } = ST.useProjectBoards(project.key)
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (boards) setDraft(draftFrom(boards))
  }, [boards])

  // The Azure DevOps project's areas, loaded (debounced) once organization and project are filled in.
  const [areas, setAreas] = useState<{ key: string; list: string[] | null; error: string | null; loading: boolean }>({ key: '', list: null, error: null, loading: false })
  const areasKey = `${draft.organization.trim()}\u0000${draft.project.trim()}`
  useEffect(() => {
    const organization = draft.organization.trim()
    const adoProject = draft.project.trim()
    if (!organization || !adoProject) return
    let cancelled = false
    setAreas((a) => ({ ...a, loading: true }))
    const t = setTimeout(() => {
      getBoardsAreas(project.key, organization, adoProject)
        .then((list) => !cancelled && setAreas({ key: areasKey, list, error: null, loading: false }))
        .catch((err: unknown) => !cancelled && setAreas({ key: areasKey, list: null, error: err instanceof ST.AppError ? err.message : 'Could not load the areas.', loading: false }))
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [areasKey, project.key, draft.organization, draft.project])
  const areaList = areas.key === areasKey ? areas.list : null
  const suggested = useMemo(() => (areaList ? suggestAreaPath(areaList, [project.name, project.key]) : null), [areaList, project.name, project.key])

  // Not saved with an area yet: pre-select the one named like this project — unless the user already chose one
  // (including "Whole project", which is '' too).
  const areaTouched = useRef(false)
  useEffect(() => {
    if (suggested && !areaTouched.current && !boards?.settings?.areaPath && !draft.areaPath) setDraft((d) => ({ ...d, areaPath: suggested }))
  }, [suggested, boards?.settings?.areaPath, draft.areaPath])

  const saved = draftFrom(boards)
  const dirty =
    !!boards?.derived ||
    draft.enabled !== saved.enabled ||
    draft.organization.trim() !== saved.organization ||
    draft.project.trim() !== saved.project ||
    draft.areaPath !== saved.areaPath ||
    splitTypes(draft.types).join(',') !== splitTypes(saved.types).join(',')
  const busy = !canEdit || saving

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const parsed = AzureBoardsSettingsSchema.safeParse({
      enabled: draft.enabled,
      organization: draft.organization,
      project: draft.project,
      areaPath: draft.areaPath || null,
      workItemTypes: splitTypes(draft.types),
    })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      setError(issue ? `${issue.path.join('.') || 'Form'}: ${issue.message}` : 'Check the form.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      setData(await ST.updateProjectBoards(project.key, parsed.data))
      UI.toast.success(`Azure Boards link saved for ${project.key}`)
    } catch (err) {
      setError(err instanceof ST.AppError ? err.message : 'Could not save the Azure Boards link.')
    } finally {
      setSaving(false)
    }
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  return (
    <UI.Card>
      <UI.CardHeader>
        <UI.CardTitle className="text-base">Azure Boards</UI.CardTitle>
        <UI.CardDescription>
          Work items assigned to each member in this Azure DevOps project (or just its area) sync here as their stories, linked back to the work item.
          Members with their own Azure DevOps access in Settings › Profile are matched exactly; others by their email or the identity they set there.
          {canEdit ? '' : ' Read-only — only owners and org admins change this.'}
        </UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>
        {loadError ? (
          <UI.ErrorAlert title="Could not load the Azure Boards link" message={loadError.message} />
        ) : loading || !boards ? (
          <UI.Skeleton className="h-48 rounded-xl" />
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <UI.FieldGroup>
              {boards.derived ? (
                <p className="text-sm text-muted-foreground">Detected from the linked Azure Repos repository — save to confirm.</p>
              ) : !boards.settings ? (
                <p className="text-sm text-muted-foreground">Not linked. Enter the Azure DevOps organization and project to sync work items from.</p>
              ) : null}
              {boards.settings && !boards.hasConnection ? (
                <UI.Alert>
                  <AlertTriangle />
                  <UI.AlertTitle>No Azure DevOps connection</UI.AlertTitle>
                  <UI.AlertDescription>
                    <p>
                      An org admin must add an Azure DevOps Git connection for <span className="font-medium">{boards.settings.organization}</span> with the
                      Work Items (Read) scope in{' '}
                      <Link href="/settings/git-connections" className="text-primary underline-offset-4 hover:underline">
                        Settings › Git connections
                      </Link>
                      .
                    </p>
                  </UI.AlertDescription>
                </UI.Alert>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <UI.Switch checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} disabled={busy} />
                Sync work items into this project
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <UI.Field>
                  <UI.FieldLabel htmlFor="boards-organization">Organization</UI.FieldLabel>
                  <UI.Input
                    id="boards-organization"
                    value={draft.organization}
                    onChange={(e) => set({ organization: e.target.value })}
                    placeholder="contoso"
                    disabled={busy}
                  />
                  <UI.FieldDescription>dev.azure.com/&lt;organization&gt;</UI.FieldDescription>
                </UI.Field>
                <UI.Field>
                  <UI.FieldLabel htmlFor="boards-project">Project</UI.FieldLabel>
                  <UI.Input id="boards-project" value={draft.project} onChange={(e) => set({ project: e.target.value })} placeholder="Payments" disabled={busy} />
                  <UI.FieldDescription>The Azure DevOps project name.</UI.FieldDescription>
                </UI.Field>
              </div>
              <UI.Field>
                <UI.FieldLabel htmlFor="boards-area">Area</UI.FieldLabel>
                <UI.Select
                  value={draft.areaPath || WHOLE_PROJECT}
                  onValueChange={(v) => {
                    areaTouched.current = true
                    set({ areaPath: v === WHOLE_PROJECT ? '' : v })
                  }}
                  disabled={busy || (!areaList && !draft.areaPath)}
                >
                  <UI.SelectTrigger id="boards-area" className="w-full">
                    <UI.SelectValue placeholder={areas.loading ? 'Loading areas…' : 'Whole project'} />
                  </UI.SelectTrigger>
                  <UI.SelectContent>
                    <UI.SelectItem value={WHOLE_PROJECT}>Whole project (every area)</UI.SelectItem>
                    {(areaList ?? (draft.areaPath ? [draft.areaPath] : [])).slice(areaList ? 1 : 0).map((a) => (
                      <UI.SelectItem key={a} value={a}>
                        {areaLabel(a)}
                        {a === suggested ? <span className="text-muted-foreground"> · matches this project</span> : null}
                      </UI.SelectItem>
                    ))}
                  </UI.SelectContent>
                </UI.Select>
                {areas.error && areas.key === areasKey ? (
                  <UI.FieldError>{areas.error}</UI.FieldError>
                ) : (
                  <UI.FieldDescription>
                    {draft.areaPath
                      ? `Only work items under ${draft.areaPath} (and its sub-areas) show on this board.`
                      : 'Pick the area for this product when one Azure DevOps project holds several.'}
                  </UI.FieldDescription>
                )}
              </UI.Field>
              <UI.Field>
                <UI.FieldLabel htmlFor="boards-types">Work item types</UI.FieldLabel>
                <UI.Input id="boards-types" value={draft.types} onChange={(e) => set({ types: e.target.value })} disabled={busy} />
                <UI.FieldDescription>Comma-separated. Only these types become stories.</UI.FieldDescription>
              </UI.Field>
              {canEdit && boards.settings?.areaPath ? <OutOfAreaStories projectKey={project.key} areaPath={boards.settings.areaPath} /> : null}
              {boards.lastSyncedAt ? (
                <p className="text-sm text-muted-foreground" title={UI.dateTime(boards.lastSyncedAt)}>
                  Last synced {UI.relativeTime(boards.lastSyncedAt)}
                </p>
              ) : null}
              {error ? <UI.FieldError>{error}</UI.FieldError> : null}
              {canEdit ? (
                <div>
                  <UI.Button type="submit" disabled={!dirty || saving}>
                    {saving ? <UI.Spinner /> : null} Save
                  </UI.Button>
                </div>
              ) : null}
            </UI.FieldGroup>
          </form>
        )}
      </UI.CardContent>
    </UI.Card>
  )
}
