'use client'

// A project's name and description (owners and org admins). The key never changes: story keys are built from it.

import { useEffect, useState, type FormEvent } from 'react'
import { UpdateProjectInputSchema, type ProjectDetail } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'

export default function GeneralCard({ project, onSaved }: { project: ProjectDetail; onSaved: (p: ProjectDetail) => void }) {
  const canEdit = project.permissions.includes('project.update')
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setName(project.name)
    setDescription(project.description)
  }, [project.name, project.description])

  const dirty = name !== project.name || description !== project.description

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const parsed = UpdateProjectInputSchema.safeParse({ name, description })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      onSaved(await ST.updateProject(project.key, parsed.data))
      UI.toast.success(`Saved ${project.key}`)
    } catch (err) {
      setError(err instanceof ST.AppError ? err.message : 'Could not save the project.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <UI.Card>
      <UI.CardHeader>
        <UI.CardTitle className="text-base">General</UI.CardTitle>
        <UI.CardDescription>{canEdit ? 'Only owners and org admins change these.' : 'Read-only — only owners and org admins change these.'}</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>
        <form onSubmit={(e) => void submit(e)}>
          <UI.FieldGroup>
            <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
              <UI.Field>
                <UI.FieldLabel htmlFor="project-settings-name">Name</UI.FieldLabel>
                <UI.Input id="project-settings-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit || saving} />
              </UI.Field>
              <UI.Field>
                <UI.FieldLabel htmlFor="project-settings-key">Key</UI.FieldLabel>
                <UI.Input id="project-settings-key" value={project.key} disabled className="font-mono" />
              </UI.Field>
            </div>
            <UI.Field>
              <UI.FieldLabel htmlFor="project-settings-description">Description</UI.FieldLabel>
              <UI.Textarea
                id="project-settings-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={!canEdit || saving}
                className="min-h-20"
              />
            </UI.Field>
            {error ? <UI.FieldError>{error}</UI.FieldError> : null}
            {canEdit ? (
              <div>
                <UI.Button type="submit" disabled={!dirty || saving || !name.trim()}>
                  {saving ? <UI.Spinner /> : null} Save
                </UI.Button>
              </div>
            ) : null}
          </UI.FieldGroup>
        </form>
      </UI.CardContent>
    </UI.Card>
  )
}
