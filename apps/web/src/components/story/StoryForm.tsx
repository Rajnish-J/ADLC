'use client'

// The new-story form, used in the board's sheet and on the /stories/new page.

import { useState, type FormEvent } from 'react'
import { CreateStoryInputSchema, STORY_PRIORITIES, type ProjectDetail, type Story, type StoryPriority } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { AppError } from '@/appError'
import { createStory } from '@/service/story.service'
import { PRIORITY_LABEL } from '@/utils/status'

interface StoryFormProps {
  project: ProjectDetail
  onCreated: (story: Story) => void
  onCancel?: () => void
}

export function StoryForm({ project, onCreated, onCancel }: StoryFormProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [criteria, setCriteria] = useState('')
  const [priority, setPriority] = useState<StoryPriority>('medium')
  const [ready, setReady] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const parsed = CreateStoryInputSchema.safeParse({
      title,
      description,
      acceptanceCriteria: criteria
        .split('\n')
        .map((line) => line.replace(/^\s*[-*•\d.)]+\s*/, '').trim())
        .filter(Boolean),
      priority,
      status: ready ? 'ready' : 'draft',
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      onCreated(await createStory(project.key, parsed.data))
      setTitle('')
      setDescription('')
      setCriteria('')
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not create the story.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="story-title">Title</FieldLabel>
          <Input id="story-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Card payment checkout" required />
        </Field>
        <Field>
          <FieldLabel htmlFor="story-description">Story</FieldLabel>
          <Textarea
            id="story-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="As a <role>, I want <capability> so that <benefit>."
            className="min-h-24"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="story-criteria">Acceptance criteria</FieldLabel>
          <Textarea
            id="story-criteria"
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder={'One per line\nA failed payment shows the reason and lets the customer retry'}
            className="min-h-28 font-mono text-xs"
          />
          <FieldDescription>One criterion per line. Agents and reviewers check the work against these.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Priority</FieldLabel>
          <Select value={priority} onValueChange={(v) => setPriority(v as StoryPriority)}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STORY_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="story-ready">Ready for developers</FieldLabel>
            <FieldDescription>Ready stories can be picked up straight away; drafts stay with leads.</FieldDescription>
          </FieldContent>
          <Switch id="story-ready" checked={ready} onCheckedChange={setReady} />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
      </FieldGroup>
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={saving}>
          {saving ? <Spinner /> : null}
          Create story
        </Button>
      </div>
    </form>
  )
}
