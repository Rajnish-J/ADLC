'use client'

// The story text. Whoever may edit the story edits it in place; it saves when the field loses focus. While
// the field is being edited, live updates from others don't overwrite what's being typed.

import { useState } from 'react'
import type { Story } from '@sdlc/contracts'
import { Textarea } from '@/components/ui/textarea'
import type { SaveStory } from '@/hooks/story/useStorySave'
import { updateStory } from '@/service/story.service'

const MAX_LENGTH = 10_000

export default function StoryDescriptionEditor({ story, save }: { story: Story; save: SaveStory }) {
  const [draft, setDraft] = useState(story.description)
  const [synced, setSynced] = useState(story.description)
  const [editing, setEditing] = useState(false)

  // Take the server's text whenever it changes and the user isn't mid-edit.
  if (!editing && story.description !== synced) {
    setSynced(story.description)
    setDraft(story.description)
  }

  if (!story.actions.canEdit) {
    return (
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Description</h3>
        <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
          {story.description || <span className="text-muted-foreground">No description.</span>}
        </p>
      </section>
    )
  }

  const id = `story-description-${story.id}`
  return (
    <section className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-semibold">
        Description
      </label>
      <Textarea
        id={id}
        value={draft}
        maxLength={MAX_LENGTH}
        placeholder="What should this story deliver, and why?"
        className="min-h-28 text-sm leading-relaxed"
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          const description = draft.trim()
          if (description === story.description.trim()) return
          void save('description', () => updateStory(story.projectKey, story.number, { version: story.version, description }), 'Description saved').then(
            (ok) => {
              if (!ok) setDraft(story.description)
            },
          )
        }}
      />
    </section>
  )
}
