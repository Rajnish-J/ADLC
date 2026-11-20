'use client'

// The board's columns and their drag and drop. Cards reorder within a column (for whoever may edit the story)
// and move to the columns the API would let them reach (see story-moves) — the others dim while a card is in
// the air. A drop hands the board the column and the cards it landed between; the board shows it at once and
// rolls it back if the API refuses (someone else moved the story first).

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  getFirstCollision,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type Active,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Over,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { STORY_STATUSES, STORY_STATUS_LABELS, type Story, type StoryStatus } from '@sdlc/contracts'
import { StoryCardView } from './StoryCard'
import StoryColumn from './StoryColumn'
import { byRank, canReorder, rankBetween, storyMoves, type DropPosition } from './story-moves'

/** Story ids per column, in board order. */
type Columns = Record<StoryStatus, string[]>

interface Drag {
  story: Story
  /** Where every card sits right now, with the dragged card moved as it's carried over columns. */
  columns: Columns
  /** The columns the card may land in — always including its own, so carrying it back cancels the move. */
  allowed: Set<StoryStatus>
}

const isStatus = (id: UniqueIdentifier): id is StoryStatus => (STORY_STATUSES as readonly string[]).includes(String(id))

function group(stories: Story[]): Columns {
  const columns = Object.fromEntries(STORY_STATUSES.map((s) => [s, [] as string[]])) as Columns
  for (const story of [...stories].sort(byRank)) columns[story.status].push(story.id)
  return columns
}

function containerOf(columns: Columns, id: UniqueIdentifier): StoryStatus | undefined {
  return isStatus(id) ? id : STORY_STATUSES.find((s) => columns[s].includes(String(id)))
}

const storyOf = (active: Active | null): Story | undefined => active?.data.current?.story as Story | undefined
const keyOf = (active: Active | null): string => storyOf(active)?.key ?? 'The story'
const placeOf = (over: Over | null): string => {
  if (!over) return ''
  if (isStatus(over.id)) return STORY_STATUS_LABELS[over.id]
  const story = over.data.current?.story as Story | undefined
  return story ? `${STORY_STATUS_LABELS[story.status]}, next to ${story.key}` : ''
}

const announcements: Announcements = {
  onDragStart: ({ active }) => `Picked up ${keyOf(active)}. Use the arrow keys to move it, Space to drop it, Escape to cancel.`,
  onDragOver: ({ active, over }) => (over ? `${keyOf(active)} is over ${placeOf(over)}.` : `${keyOf(active)} is not over a place it can go.`),
  onDragEnd: ({ active, over }) => (over ? `${keyOf(active)} dropped in ${placeOf(over)}.` : `${keyOf(active)} dropped where it was.`),
  onDragCancel: ({ active }) => `Moving ${keyOf(active)} was cancelled.`,
}

interface Props {
  /** The stories the filters let through. */
  stories: Story[]
  /** A drop that changes something: the column, the cards it landed between, and the rank to show meanwhile. */
  onDrop: (story: Story, to: StoryStatus, position: DropPosition, rank: number) => void
  onOpen: (story: Story) => void
  onChange: (story: Story) => void
}

export default function StoryBoardDnd({ stories, onDrop, onOpen, onChange }: Props) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const lastOver = useRef<UniqueIdentifier | null>(null)
  const byId = useMemo(() => new Map(stories.map((s) => [s.id, s])), [stories])
  const settled = useMemo(() => group(stories), [stories])
  const columns = drag?.columns ?? settled

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click still opens the card.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Press and hold on touch screens, so a swipe still scrolls the board.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    // Space picks a card up; Enter is left to open it.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  )

  // Only the allowed columns (and their cards) are targets. Over a column, aim at its closest card so the
  // dragged card slots in between; between targets, stay with the last one so the layout doesn't flicker.
  const collision = useCallback<CollisionDetection>(
    (args) => {
      if (!drag) return closestCenter(args)
      const droppableContainers = args.droppableContainers.filter((c) => {
        const column = containerOf(drag.columns, c.id)
        return column !== undefined && drag.allowed.has(column)
      })
      const scoped = { ...args, droppableContainers }
      const pointer = pointerWithin(scoped)
      let overId = getFirstCollision(pointer.length > 0 ? pointer : rectIntersection(scoped), 'id')
      if (overId != null) {
        if (isStatus(overId)) {
          const ids = drag.columns[overId]
          if (ids.length > 0) {
            const column = overId
            overId = closestCenter({ ...scoped, droppableContainers: droppableContainers.filter((c) => c.id !== column && ids.includes(String(c.id))) })[0]?.id ?? overId
          }
        }
        lastOver.current = overId
        return [{ id: overId }]
      }
      return lastOver.current != null ? [{ id: lastOver.current }] : []
    },
    [drag],
  )

  function onDragStart({ active }: DragStartEvent): void {
    const story = byId.get(String(active.id))
    if (!story) return
    lastOver.current = null
    setDrag({ story, columns: settled, allowed: new Set([story.status, ...storyMoves(story).map((m) => m.to)]) })
  }

  // Carrying a card over another column moves it there (as a placeholder) so the cards make room.
  function onDragOver({ active, over }: DragOverEvent): void {
    if (!drag || !over) return
    const from = containerOf(drag.columns, active.id)
    const to = containerOf(drag.columns, over.id)
    if (!from || !to || from === to || !drag.allowed.has(to)) return
    const id = String(active.id)
    setDrag((d) => {
      if (!d) return d
      const target = d.columns[to].filter((x) => x !== id)
      let index = target.length
      if (!isStatus(over.id)) {
        const overIndex = target.indexOf(String(over.id))
        const translated = active.rect.current.translated
        const below = translated !== null && translated.top > over.rect.top + over.rect.height / 2
        if (overIndex >= 0) index = overIndex + (below ? 1 : 0)
      }
      return {
        ...d,
        columns: { ...d.columns, [from]: d.columns[from].filter((x) => x !== id), [to]: [...target.slice(0, index), id, ...target.slice(index)] },
      }
    })
  }

  function onDragEnd({ active, over }: DragEndEvent): void {
    const d = drag
    setDrag(null)
    lastOver.current = null
    if (!d || !over) return
    const id = String(active.id)
    const to = containerOf(d.columns, id)
    if (!to) return

    let ids = d.columns[to]
    if (!isStatus(over.id) && String(over.id) !== id && containerOf(d.columns, over.id) === to) {
      ids = arrayMove(ids, ids.indexOf(id), ids.indexOf(String(over.id)))
    }
    const { story } = d
    // Back in its own column: a reorder, if the order changed and the user may reorder it.
    if (to === story.status && (!canReorder(story) || ids.join() === settled[to].join())) return

    const index = ids.indexOf(id)
    const afterId = ids[index - 1] ?? null
    const beforeId = ids[index + 1] ?? null
    const rank = rankBetween(afterId ? byId.get(afterId)?.rank : undefined, beforeId ? byId.get(beforeId)?.rank : undefined, story.rank)
    onDrop(story, to, { afterId, beforeId }, rank)
  }

  return (
    <DndContext
      id="story-board"
      sensors={sensors}
      collisionDetection={collision}
      accessibility={{ announcements }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDrag(null)
        lastOver.current = null
      }}
    >
      {/* Fixed height: each column scrolls on its own (dragging near an edge scrolls it); sideways on narrow screens. */}
      <div className="flex h-[calc(100svh-9rem)] min-h-105 gap-3 overflow-x-auto pb-1">
        {STORY_STATUSES.map((status) => (
          <StoryColumn
            key={status}
            status={status}
            stories={columns[status].map((id) => byId.get(id)).filter((s): s is Story => s !== undefined)}
            accepts={drag && status !== drag.story.status ? drag.allowed.has(status) : null}
            onOpen={onOpen}
            onChange={onChange}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {drag ? <StoryCardView story={drag.story} className="rotate-2 cursor-grabbing shadow-xl ring-1 ring-primary/30" /> : null}
      </DragOverlay>
    </DndContext>
  )
}
