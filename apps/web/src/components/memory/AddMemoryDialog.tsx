'use client'

// Add a memory item — to a story (anyone working on it) or straight to project memory (leads).

import { useState, type ReactNode } from 'react'
import { CreateMemoryInputSchema, type MemoryKind } from '@sdlc/contracts'
import { AppError } from '@/appError'
import * as UI from '@/imports/UI.imports'
import { addProjectMemory, addStoryMemory } from '@/service/memory.service'
import { KIND_META, WRITABLE_KINDS } from './memory-meta'

interface Props {
  projectKey: string
  /** Story memory when set; project memory otherwise. */
  storyNumber?: number
  trigger: ReactNode
  onAdded?: () => void
}

export default function AddMemoryDialog({ projectKey, storyNumber, trigger, onAdded }: Props) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<MemoryKind>(storyNumber ? 'note' : 'convention')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [pinned, setPinned] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const isProject = storyNumber === undefined

  const reset = () => {
    setTitle('')
    setContent('')
    setPinned(false)
    setError(null)
  }

  const submit = async () => {
    const parsed = CreateMemoryInputSchema.safeParse({ kind, title, content, ...(isProject ? { pinned } : {}) })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the fields')
      return
    }
    setSaving(true)
    try {
      if (isProject) await addProjectMemory(projectKey, parsed.data)
      else await addStoryMemory(projectKey, storyNumber, parsed.data)
      UI.toast.success(isProject ? 'Added to project memory' : 'Added to the story’s memory')
      reset()
      setOpen(false)
      onAdded?.()
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <UI.Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) reset()
      }}
    >
      <UI.DialogTrigger asChild>{trigger}</UI.DialogTrigger>
      <UI.DialogContent className="sm:max-w-lg">
        <UI.DialogHeader>
          <UI.DialogTitle>{isProject ? 'Add to project memory' : 'Add to story memory'}</UI.DialogTitle>
          <UI.DialogDescription>
            {isProject
              ? 'Shared with every developer and agent working in this project.'
              : 'Kept with this story and given to agents that work on it. Promote it later if the whole project should know.'}
          </UI.DialogDescription>
        </UI.DialogHeader>
        <UI.FieldGroup>
          <UI.Field>
            <UI.FieldLabel>Kind</UI.FieldLabel>
            <UI.ToggleGroup type="single" variant="outline" value={kind} onValueChange={(v) => v && setKind(v as MemoryKind)} className="flex-wrap">
              {WRITABLE_KINDS.map((k) => {
                const Icon = KIND_META[k].icon
                return (
                  <UI.ToggleGroupItem key={k} value={k} className="px-3">
                    <Icon /> {KIND_META[k].label}
                  </UI.ToggleGroupItem>
                )
              })}
            </UI.ToggleGroup>
            <UI.FieldDescription>{KIND_META[kind].hint}.</UI.FieldDescription>
          </UI.Field>
          <UI.Field>
            <UI.FieldLabel htmlFor="memory-title">Title</UI.FieldLabel>
            <UI.Input id="memory-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Amounts are stored in minor units" autoFocus />
          </UI.Field>
          <UI.Field>
            <UI.FieldLabel htmlFor="memory-content">Details</UI.FieldLabel>
            <UI.Textarea id="memory-content" value={content} rows={5} maxLength={20_000} onChange={(e) => setContent(e.target.value)} placeholder="Why, where, and how — enough for someone (or an agent) new to the code." />
          </UI.Field>
          {isProject ? (
            <UI.Field orientation="horizontal">
              <UI.Switch id="memory-pinned" checked={pinned} onCheckedChange={setPinned} />
              <UI.FieldContent>
                <UI.FieldLabel htmlFor="memory-pinned">Pin for every agent</UI.FieldLabel>
                <UI.FieldDescription>Pinned items are always included in agents’ prompts.</UI.FieldDescription>
              </UI.FieldContent>
            </UI.Field>
          ) : null}
          {error ? <UI.FieldError>{error}</UI.FieldError> : null}
        </UI.FieldGroup>
        <UI.DialogFooter>
          <UI.Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </UI.Button>
          <UI.Button onClick={() => void submit()} disabled={saving || !title.trim()}>
            {saving ? <UI.Spinner /> : null} Save
          </UI.Button>
        </UI.DialogFooter>
      </UI.DialogContent>
    </UI.Dialog>
  )
}
