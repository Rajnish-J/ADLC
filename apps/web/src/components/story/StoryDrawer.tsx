'use client'

// A story opened from the board, in a drawer that floats on the right — inset from the top, bottom and right
// edges. It edits in place (every change saves as it's made) and "Open full story" goes to the story page.
// The story comes from the board's own list, so the drawer and the board can never disagree.

import { useState } from 'react'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import type { ProjectDetail, Story } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import StoryMemoryPanel from '@/components/memory/StoryMemoryPanel'
import { useStorySave } from '@/hooks/story/useStorySave'
import { shortDate } from '@/utils/format'
import AcceptanceCriteriaList from './AcceptanceCriteriaList'
import StoryDescriptionEditor from './StoryDescriptionEditor'
import StoryProperties from './StoryProperties'
import StoryStatePill from './StoryStatePill'

// Overrides for ui/sheet's right side (tailwind-merge replaces the matching classes): float it with a gap above,
// below and to the right, rounded, and wider than the default sheet.
const FLOATING =
  'gap-0 overflow-hidden rounded-2xl border shadow-2xl outline-nonedata-[side=right]:inset-y-3 data-[side=right]:right-3 data-[side=right]:h-auto data-[side=right]:w-[calc(100%-1.5rem)] data-[side=right]:sm:inset-y-4 data-[side=right]:sm:right-4 data-[side=right]:sm:max-w-xl'

function Loading() {
  return (
    <>
      <SheetHeader className="gap-2 border-b px-6 pt-6 pb-5">
        <SheetTitle className="sr-only">Loading story</SheetTitle>
        <SheetDescription className="sr-only">The story is loading.</SheetDescription>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-4 w-48" />
      </SheetHeader>
      <div className="flex flex-col gap-3 px-6 py-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
        <Skeleton className="mt-3 h-28" />
      </div>
    </>
  )
}

function Missing({ number }: { number: number }) {
  return (
    <SheetHeader className="px-6 pt-6">
      <SheetTitle>Story not found</SheetTitle>
      <SheetDescription>There is no story #{number} on this board, or you can no longer see it.</SheetDescription>
    </SheetHeader>
  )
}

interface BodyProps {
  story: Story
  project: ProjectDetail
  labelSuggestions: string[]
  onChange: (story: Story) => void
  reload: () => Promise<void>
}

function Body({ story, project, labelSuggestions, onChange, reload }: BodyProps) {
  const { busy, save } = useStorySave(onChange, reload)
  return (
    <>
      <SheetHeader className="gap-2 border-b px-6 pt-6 pb-5 pr-14">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-medium text-muted-foreground">{story.key}</span>
          <StoryStatePill story={story} />
        </div>
        <SheetTitle className="text-lg leading-snug font-semibold">{story.title}</SheetTitle>
        <SheetDescription>
          Raised by {story.createdBy.displayName} · {shortDate(story.createdAt)}
        </SheetDescription>
      </SheetHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-6 px-6 py-5">
          <StoryProperties story={story} project={project} busy={busy} save={save} labelSuggestions={labelSuggestions} />
          <Separator />
          <StoryDescriptionEditor story={story} save={save} />
          <AcceptanceCriteriaList story={story} onChange={onChange} />
          <Separator />
          <StoryMemoryPanel projectKey={story.projectKey} storyNumber={story.number} canAdd={story.actions.canAddMemory} compact />
        </div>
      </ScrollArea>
      <SheetFooter className="flex-row items-center justify-between gap-3 border-t px-6 py-3.5">
        <span className="text-xs text-muted-foreground">Changes save automatically</span>
        <Button asChild>
          <Link href={`/projects/${story.projectKey}/stories/${story.number}`}>
            Open full story
            <ExternalLink data-icon="inline-end" />
          </Link>
        </Button>
      </SheetFooter>
    </>
  )
}

interface Props {
  project: ProjectDetail
  /** The story number in the URL (`?story=`), or null when the drawer is closed. */
  number: number | null
  /** That story from the board's list — null while the board loads or if there is no such story. */
  story: Story | null
  loading: boolean
  /** Labels used across the project, offered while adding one. */
  labelSuggestions: string[]
  onClose: () => void
  onChange: (story: Story) => void
  reload: () => Promise<void>
}

export default function StoryDrawer({ project, number, story, loading, labelSuggestions, onClose, onChange, reload }: Props) {
  // Keep showing the last story while the drawer animates closed.
  const [last, setLast] = useState<{ number: number; story: Story | null } | null>(null)
  if (number !== null && (last?.number !== number || last.story !== story)) setLast({ number, story })

  const shown = number !== null ? { number, story } : last
  return (
    <Sheet open={number !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className={FLOATING}>
        {shown === null ? null : shown.story ? (
          <Body story={shown.story} project={project} labelSuggestions={labelSuggestions} onChange={onChange} reload={reload} />
        ) : loading ? (
          <Loading />
        ) : (
          <Missing number={shown.number} />
        )}
      </SheetContent>
    </Sheet>
  )
}
