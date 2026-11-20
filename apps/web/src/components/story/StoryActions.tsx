'use client'

// What the signed-in user may do with this story right now. Every button comes from the story's `actions`,
// which the API computes with the same rules it enforces — nothing here can be clicked and then refused.

import { useState } from 'react'
import { ArrowRight, Ban, Hand, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { Story } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { AppError } from '@/appError'
import { moveStory, pickUpStory, updateStory } from '@/service/story.service'

interface Props {
  story: Story
  onChange: (story: Story) => void
}

export default function StoryActions({ story, onChange }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [blockReason, setBlockReason] = useState('')
  const { actions } = story

  async function run(id: string, done: string, action: () => Promise<Story>): Promise<boolean> {
    setBusy(id)
    try {
      onChange(await action())
      toast.success(done)
      return true
    } catch (err) {
      toast.error(err instanceof AppError ? err.message : 'That did not work.')
      return false
    } finally {
      setBusy(null)
    }
  }

  const nothing = !actions.canPickUp && actions.transitions.length === 0 && !actions.canEdit
  if (nothing) {
    return (
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        You can view this story but not change it.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {actions.canPickUp ? (
        <Button
          className="w-full"
          disabled={busy !== null}
          onClick={() => void run('pickup', `You picked up ${story.key}`, () => pickUpStory(story.projectKey, story.number))}
        >
          {busy === 'pickup' ? <Spinner /> : <Hand />}
          Pick up this story
        </Button>
      ) : null}

      {actions.transitions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Move to</p>
          <div className="flex flex-wrap gap-2">
            {actions.transitions.map((t) => (
              <Button
                key={t.to}
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void run(t.to, `${story.key}: ${t.label.toLowerCase()}`, () => moveStory(story.projectKey, story.number, t.to))}
              >
                {busy === t.to ? <Spinner /> : <ArrowRight />}
                {t.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {actions.canEdit ? (
        <>
          <Separator />
          {story.isBlocked ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void run('unblock', 'Blocker cleared', () => updateStory(story.projectKey, story.number, { version: story.version, isBlocked: false }))
              }
            >
              {busy === 'unblock' ? <Spinner /> : <Ban />}
              Clear blocker
            </Button>
          ) : (
            <Field>
              <FieldLabel htmlFor="block-reason">Flag a blocker</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="block-reason"
                  value={blockReason}
                  onChange={(e) => setBlockReason(e.target.value)}
                  placeholder="What's in the way?"
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    disabled={busy !== null || !blockReason.trim()}
                    onClick={() =>
                      void run('block', `${story.key} flagged as blocked`, () =>
                        updateStory(story.projectKey, story.number, { version: story.version, isBlocked: true, blockedReason: blockReason.trim() }),
                      ).then((ok) => ok && setBlockReason(''))
                    }
                  >
                    Flag
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              <FieldDescription>Leads see blocked stories on the board.</FieldDescription>
            </Field>
          )}
        </>
      ) : null}
    </div>
  )
}
