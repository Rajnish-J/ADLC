'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import type { Story } from '@sdlc/contracts'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldLabel } from '@/components/ui/field'
import { Progress } from '@/components/ui/progress'
import { AppError } from '@/appError'
import { cn } from '@/lib/utils'
import { updateStory } from '@/service/story.service'

interface Props {
  story: Story
  onChange: (story: Story) => void
}

/** The story's acceptance criteria; whoever may edit the story can tick them off. */
export default function AcceptanceCriteriaList({ story, onChange }: Props) {
  const [saving, setSaving] = useState<string | null>(null)
  const total = story.acceptanceCriteria.length
  const met = story.acceptanceCriteria.filter((c) => c.met).length

  async function toggle(id: string, value: boolean): Promise<void> {
    setSaving(id)
    try {
      const acceptanceCriteria = story.acceptanceCriteria.map((c) => (c.id === id ? { ...c, met: value } : c))
      onChange(await updateStory(story.projectKey, story.number, { version: story.version, acceptanceCriteria }))
    } catch (err) {
      toast.error(err instanceof AppError ? err.message : 'Could not update the criterion.')
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold">Acceptance criteria</h2>
        {total > 0 ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {met} of {total} met
          </span>
        ) : null}
      </div>
      {total > 0 ? <Progress value={(met / total) * 100} className="h-1.5" /> : null}
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">No acceptance criteria yet.</p>
      ) : (
        <div className="flex flex-col divide-y rounded-lg border">
          {story.acceptanceCriteria.map((c) => (
            <Field key={c.id} orientation="horizontal" className="px-3 py-2.5">
              <Checkbox
                id={`ac-${c.id}`}
                checked={c.met}
                disabled={!story.actions.canEdit || saving !== null}
                onCheckedChange={(v) => void toggle(c.id, v === true)}
              />
              <FieldLabel htmlFor={`ac-${c.id}`} className={cn('font-normal leading-snug', c.met && 'text-muted-foreground line-through')}>
                {c.text}
              </FieldLabel>
            </Field>
          ))}
        </div>
      )}
    </section>
  )
}
