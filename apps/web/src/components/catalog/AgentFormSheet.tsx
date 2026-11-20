'use client'

// Create or edit one of the project's platform agents (agents defined on the platform rather than in a repository).
// Built-in and codebase agents are read-only — they change by editing their definition files. A new agent starts
// enabled for the project, so the workflow editor can map it onto a step straight away.

import { useEffect, useState, type FormEvent } from 'react'
import { z } from 'zod'
import {
  CreatePlatformAgentInputSchema,
  PROJECT_ROLE_LABELS,
  PROJECT_ROLES,
  UpdatePlatformAgentInputSchema,
  type AgentDetail,
  type ProjectRole,
} from '@sdlc/contracts'
import { SDLC_STEPS, STEP_LABELS } from '@sdlc/core'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { createAgent, getAgent, updateAgent } from '@/service/catalog.service'

export type AgentFormMode = { type: 'create'; name?: string } | { type: 'edit'; slug: string }

interface Values {
  name: string
  slug: string
  description: string
  instructions: string
  category: string
  sdlcStage: string
  tools: string
  model: string
  minProjectRole: ProjectRole | ''
}

const EMPTY: Values = {
  name: '',
  slug: '',
  description: '',
  instructions: '',
  category: 'general',
  sdlcStage: 'implement',
  tools: '',
  model: '',
  minProjectRole: '',
}

const ANYONE = '__anyone'

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

function fromDetail(a: AgentDetail): Values {
  return {
    name: a.name,
    slug: a.slug,
    description: a.description,
    instructions: a.instructions,
    category: a.category,
    sdlcStage: a.sdlcStage,
    tools: a.tools.join(', '),
    model: a.model ?? '',
    minProjectRole: a.requiredRole ?? '',
  }
}

function toInput(v: Values) {
  return {
    name: v.name,
    description: v.description,
    instructions: v.instructions,
    category: v.category || 'general',
    sdlcStage: v.sdlcStage || 'implement',
    tools: v.tools
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean),
    model: v.model.trim() || null,
    minProjectRole: v.minProjectRole || null,
  }
}

function fieldErrors(error: z.ZodError): Partial<Record<keyof Values, string>> {
  const out: Partial<Record<keyof Values, string>> = {}
  for (const issue of error.issues) {
    const key = issue.path[0] as keyof Values | undefined
    if (key && !out[key]) out[key] = issue.message
  }
  return out
}

interface AgentFormSheetProps {
  projectKey: string
  /** null closes the sheet. */
  mode: AgentFormMode | null
  onClose: () => void
  onSaved: (agent: AgentDetail) => void
}

export default function AgentFormSheet({ projectKey, mode, onClose, onSaved }: AgentFormSheetProps) {
  const [values, setValues] = useState<Values>(EMPTY)
  const [slugEdited, setSlugEdited] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<keyof Values, string>>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const editing = mode?.type === 'edit'

  // Reset (create) or load the agent (edit) each time the sheet opens.
  useEffect(() => {
    setErrors({})
    setSlugEdited(false)
    if (!mode) return
    if (mode.type === 'create') {
      setValues({ ...EMPTY, name: mode.name ?? '', slug: slugify(mode.name ?? '') })
      return
    }
    let cancelled = false
    setLoading(true)
    getAgent(projectKey, mode.slug)
      .then((a) => !cancelled && setValues(fromDetail(a)))
      .catch((err) => {
        if (cancelled) return
        UI.toast.error(err instanceof AppError ? err.message : 'Could not load the agent.')
        onClose()
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // Reload only when the sheet opens for another agent (not when the parent re-renders with a new `mode` object).
  }, [mode?.type, mode?.type === 'edit' ? mode.slug : null, projectKey])

  function set<K extends keyof Values>(key: K, value: Values[K]): void {
    setValues((v) => {
      const next = { ...v, [key]: value }
      if (key === 'name' && !editing && !slugEdited) next.slug = slugify(String(value))
      return next
    })
    setErrors((e) => ({ ...e, [key]: undefined }))
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!mode) return
    const create = mode.type === 'create' ? CreatePlatformAgentInputSchema.safeParse({ ...toInput(values), kind: 'agent', slug: values.slug }) : null
    const update = mode.type === 'edit' ? UpdatePlatformAgentInputSchema.safeParse(toInput(values)) : null
    const failed = create && !create.success ? create.error : update && !update.success ? update.error : null
    if (failed) {
      setErrors(fieldErrors(failed))
      return
    }
    setSaving(true)
    try {
      const saved =
        mode.type === 'create' && create?.success
          ? await createAgent(projectKey, create.data)
          : mode.type === 'edit' && update?.success
            ? await updateAgent(projectKey, mode.slug, update.data)
            : null
      if (!saved) return
      UI.toast.success(mode.type === 'create' ? `${saved.name} created and enabled for ${projectKey}` : `${saved.name} saved`)
      onSaved(saved)
      onClose()
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not save the agent.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <UI.Sheet open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      <UI.SheetContent className="w-full gap-0 sm:max-w-xl">
        <UI.SheetHeader className="border-b">
          <UI.SheetTitle>{editing ? `Edit ${values.name || 'agent'}` : 'New agent'}</UI.SheetTitle>
          <UI.SheetDescription>
            {editing
              ? 'Changes apply to every workflow step that runs this agent, from the next run on.'
              : 'A platform agent for this project. It starts enabled, and you can map it onto any agent step.'}
          </UI.SheetDescription>
        </UI.SheetHeader>
        {loading ? (
          <div className="flex flex-col gap-4 p-4">
            <UI.Skeleton className="h-9" />
            <UI.Skeleton className="h-20" />
            <UI.Skeleton className="h-64" />
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <UI.FieldGroup className="gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <UI.Field data-invalid={!!errors.name}>
                    <UI.FieldLabel htmlFor="agent-name">Name</UI.FieldLabel>
                    <UI.Input id="agent-name" value={values.name} onChange={(e) => set('name', e.target.value)} placeholder="API test writer" autoFocus aria-invalid={!!errors.name} />
                    {errors.name ? <UI.FieldError>{errors.name}</UI.FieldError> : null}
                  </UI.Field>
                  <UI.Field data-invalid={!!errors.slug}>
                    <UI.FieldLabel htmlFor="agent-slug">Slug</UI.FieldLabel>
                    <UI.Input
                      id="agent-slug"
                      value={values.slug}
                      disabled={editing}
                      onChange={(e) => {
                        setSlugEdited(true)
                        set('slug', e.target.value)
                      }}
                      className="font-mono"
                      aria-invalid={!!errors.slug}
                    />
                    {errors.slug ? <UI.FieldError>{errors.slug}</UI.FieldError> : <UI.FieldDescription>{editing ? 'Fixed once created.' : 'How workflows refer to it.'}</UI.FieldDescription>}
                  </UI.Field>
                </div>
                <UI.Field data-invalid={!!errors.description}>
                  <UI.FieldLabel htmlFor="agent-description">What it does</UI.FieldLabel>
                  <UI.Textarea
                    id="agent-description"
                    rows={2}
                    value={values.description}
                    onChange={(e) => set('description', e.target.value)}
                    placeholder="Writes integration tests for new API routes."
                    aria-invalid={!!errors.description}
                  />
                  {errors.description ? <UI.FieldError>{errors.description}</UI.FieldError> : null}
                </UI.Field>
                <UI.Field data-invalid={!!errors.instructions}>
                  <UI.FieldLabel htmlFor="agent-instructions">Instructions</UI.FieldLabel>
                  <UI.Textarea
                    id="agent-instructions"
                    rows={12}
                    value={values.instructions}
                    onChange={(e) => set('instructions', e.target.value)}
                    placeholder={'You are … When you are given a task:\n1. …'}
                    className="font-mono text-xs"
                    aria-invalid={!!errors.instructions}
                  />
                  {errors.instructions ? <UI.FieldError>{errors.instructions}</UI.FieldError> : <UI.FieldDescription>Markdown. The harness gives these to the agent on every step it runs.</UI.FieldDescription>}
                </UI.Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <UI.Field>
                    <UI.FieldLabel htmlFor="agent-stage">SDLC stage</UI.FieldLabel>
                    <UI.Select value={values.sdlcStage} onValueChange={(v) => set('sdlcStage', v)}>
                      <UI.SelectTrigger id="agent-stage" className="w-full">
                        <UI.SelectValue />
                      </UI.SelectTrigger>
                      <UI.SelectContent>
                        {SDLC_STEPS.map((s) => (
                          <UI.SelectItem key={s} value={s}>
                            {STEP_LABELS[s]}
                          </UI.SelectItem>
                        ))}
                        {!SDLC_STEPS.includes(values.sdlcStage as never) ? <UI.SelectItem value={values.sdlcStage}>{values.sdlcStage}</UI.SelectItem> : null}
                      </UI.SelectContent>
                    </UI.Select>
                  </UI.Field>
                  <UI.Field data-invalid={!!errors.category}>
                    <UI.FieldLabel htmlFor="agent-category">Category</UI.FieldLabel>
                    <UI.Input id="agent-category" value={values.category} onChange={(e) => set('category', e.target.value)} aria-invalid={!!errors.category} />
                    {errors.category ? <UI.FieldError>{errors.category}</UI.FieldError> : null}
                  </UI.Field>
                </div>
                <UI.Field data-invalid={!!errors.tools}>
                  <UI.FieldLabel htmlFor="agent-tools">Tools</UI.FieldLabel>
                  <UI.Input id="agent-tools" value={values.tools} onChange={(e) => set('tools', e.target.value)} placeholder="Read, Grep, Edit" className="font-mono text-xs" aria-invalid={!!errors.tools} />
                  {errors.tools ? <UI.FieldError>{errors.tools}</UI.FieldError> : <UI.FieldDescription>Comma-separated allow-list. Leave empty for an agent that only reasons over what it is given.</UI.FieldDescription>}
                </UI.Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <UI.Field data-invalid={!!errors.model}>
                    <UI.FieldLabel htmlFor="agent-model">Model</UI.FieldLabel>
                    <UI.Input id="agent-model" value={values.model} onChange={(e) => set('model', e.target.value)} placeholder="Harness default" aria-invalid={!!errors.model} />
                    {errors.model ? <UI.FieldError>{errors.model}</UI.FieldError> : null}
                  </UI.Field>
                  <UI.Field>
                    <UI.FieldLabel htmlFor="agent-role">Who can use it</UI.FieldLabel>
                    <UI.Select value={values.minProjectRole || ANYONE} onValueChange={(v) => set('minProjectRole', v === ANYONE ? '' : (v as ProjectRole))}>
                      <UI.SelectTrigger id="agent-role" className="w-full">
                        <UI.SelectValue />
                      </UI.SelectTrigger>
                      <UI.SelectContent>
                        <UI.SelectItem value={ANYONE}>Everyone on the project</UI.SelectItem>
                        {[...PROJECT_ROLES].reverse().map((r) => (
                          <UI.SelectItem key={r} value={r}>
                            {PROJECT_ROLE_LABELS[r]} and above
                          </UI.SelectItem>
                        ))}
                      </UI.SelectContent>
                    </UI.Select>
                  </UI.Field>
                </div>
              </UI.FieldGroup>
            </div>
            <div className="flex justify-end gap-2 border-t p-4">
              <UI.Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                Cancel
              </UI.Button>
              <UI.Button type="submit" disabled={saving}>
                {saving ? <UI.Spinner /> : null} {editing ? 'Save agent' : 'Create agent'}
              </UI.Button>
            </div>
          </form>
        )}
      </UI.SheetContent>
    </UI.Sheet>
  )
}
