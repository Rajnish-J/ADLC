'use client'

import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { STORY_STATUS_LABELS, type Story, type StoryStatus } from '@sdlc/contracts'
import { cn } from '@/lib/utils'
import { STATUS_DOT } from '@/utils/status'
import StoryCard from './StoryCard'
import { canDrag } from './story-moves'

interface Props {
  status: StoryStatus
  /** The column's stories in board order (during a drag, as they'd land). */
  stories: Story[]
  /** While a card is being dragged from another column: whether it may land here. Null otherwise. */
  accepts: boolean | null
  onOpen: (story: Story) => void
  onChange: (story: Story) => void
}

/** One board column: a sortable list, and a drop target for the cards allowed to move here. */
export default function StoryColumn({ status, stories, accepts, onOpen, onChange }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: accepts === false })
  return (
    <section
      ref={setNodeRef}
      aria-label={STORY_STATUS_LABELS[status]}
      className={cn(
        'flex h-full min-h-0 min-w-60 flex-1 basis-0 flex-col rounded-xl border bg-muted/40 transition-[opacity,box-shadow,background-color]',
        accepts === false && 'opacity-45',
        accepts === true && 'border-dashed border-primary/40',
        accepts === true && isOver && 'border-solid bg-primary/5 ring-2 ring-primary/30',
      )}
    >
      <header className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <span className={cn('size-2 rounded-full', STATUS_DOT[status])} aria-hidden />
        <h2 className="text-sm font-semibold">{STORY_STATUS_LABELS[status]}</h2>
        <span className="ml-auto min-w-6 rounded-full border bg-background px-1.5 text-center text-xs tabular-nums text-muted-foreground">
          {stories.length}
        </span>
      </header>
      <SortableContext id={status} items={stories.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2 pb-2 scrollbar-gutter-stable *:shrink-0">
          {stories.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">{accepts ? 'Drop here' : 'No stories'}</p>
          ) : (
            stories.map((s) => <StoryCard key={s.id} story={s} draggable={canDrag(s)} onOpen={onOpen} onChange={onChange} />)
          )}
        </div>
      </SortableContext>
    </section>
  )
}
