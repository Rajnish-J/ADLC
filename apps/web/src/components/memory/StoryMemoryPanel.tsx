'use client'

// A story's memory: notes, decisions and learnings from working on it, plus what agent runs captured. Usable on
// the story page and (compact) in the board's story drawer.

import { useState } from 'react'
import Link from 'next/link'
import { Brain, Plus } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import { useStoryMemory } from '@/hooks/memory/useMemory'
import AddMemoryDialog from './AddMemoryDialog'
import MemoryItemCard from './MemoryItemCard'

interface Props {
  projectKey: string
  storyNumber: number
  /** Whether the viewer may add to it (Story.actions.canAddMemory). */
  canAdd?: boolean
  /** Short list (first 3, titles only) with a link to the story page's Memory tab. */
  compact?: boolean
}

export default function StoryMemoryPanel({ projectKey, storyNumber, canAdd, compact }: Props) {
  const { data, error, loading, reload } = useStoryMemory(projectKey, storyNumber)
  const [showArchived, setShowArchived] = useState(false)
  const items = (data ?? []).filter((m) => showArchived || m.status !== 'archived')
  const archived = (data ?? []).filter((m) => m.status === 'archived').length
  const addButton = canAdd ? (
    <AddMemoryDialog
      projectKey={projectKey}
      storyNumber={storyNumber}
      onAdded={() => void reload()}
      trigger={
        <UI.Button size="sm" variant={compact ? 'outline' : 'default'}>
          <Plus /> Add
        </UI.Button>
      }
    />
  ) : null

  if (error) return <UI.ErrorAlert title="Could not load memory" message={error.message} />
  if (loading && !data) return <UI.Skeleton className="h-32 rounded-xl" />

  if (compact) {
    const shown = items.slice(0, 3)
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Memory {items.length ? <span className="text-muted-foreground">({items.length})</span> : null}</h3>
          {addButton}
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <UI.ItemGroup className="gap-2">
            {shown.map((m) => (
              <MemoryItemCard key={m.id} item={m} projectKey={projectKey} compact onChanged={() => void reload()} />
            ))}
          </UI.ItemGroup>
        )}
        {items.length > 0 ? (
          <Link href={`/projects/${projectKey}/stories/${storyNumber}?tab=memory`} className="text-xs font-medium text-primary hover:underline">
            {items.length > shown.length ? `View all ${items.length}` : 'Open memory'}
          </Link>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-sm text-muted-foreground">
          Notes, decisions and learnings from working on this story — including what agent runs captured. Agents started on the story are given
          them along with the project’s knowledge.
        </p>
        <div className="flex items-center gap-3">
          {archived ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <UI.Switch checked={showArchived} onCheckedChange={setShowArchived} /> Archived ({archived})
            </label>
          ) : null}
          {addButton}
        </div>
      </div>
      {items.length === 0 ? (
        <UI.EmptyState
          icon={<Brain />}
          title="Nothing remembered yet"
          description={canAdd ? 'Add a note or decision — or let agent runs capture what they learn.' : 'Notes and decisions appear here as the story is worked on.'}
        />
      ) : (
        <UI.ItemGroup className="gap-3">
          {items.map((m) => (
            <MemoryItemCard key={m.id} item={m} projectKey={projectKey} onChanged={() => void reload()} />
          ))}
        </UI.ItemGroup>
      )}
    </div>
  )
}
