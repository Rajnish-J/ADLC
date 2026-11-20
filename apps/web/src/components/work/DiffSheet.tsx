'use client'

// A commit's or a working state's diff in a side sheet, fetched when opened.

import { useState, type ReactNode } from 'react'
import * as UI from '@/imports/UI.imports'
import { useDiff, type DiffTarget } from '@/hooks/work/useStoryWork'
import DiffView from './DiffView'

interface Props {
  projectKey: string
  storyNumber: number
  target: DiffTarget
  title: string
  description?: ReactNode
  trigger: ReactNode
}

export default function DiffSheet({ projectKey, storyNumber, target, title, description, trigger }: Props) {
  const [open, setOpen] = useState(false)
  const diff = useDiff(projectKey, storyNumber)
  return (
    <UI.Sheet
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v) void diff.load(target)
      }}
    >
      <UI.SheetTrigger asChild>{trigger}</UI.SheetTrigger>
      <UI.SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
        <UI.SheetHeader className="border-b">
          <UI.SheetTitle>{title}</UI.SheetTitle>
          {description ? <UI.SheetDescription>{description}</UI.SheetDescription> : null}
        </UI.SheetHeader>
        <div className="flex-1 overflow-y-auto p-4">
          {diff.loading ? (
            <UI.Skeleton className="h-64" />
          ) : diff.error ? (
            <UI.ErrorAlert title="Could not load the diff" message={diff.error} />
          ) : diff.patch?.patch ? (
            <DiffView patch={diff.patch.patch} truncated={diff.patch.patchTruncated} />
          ) : (
            <p className="text-sm text-muted-foreground">No diff was shared for this change.</p>
          )}
        </div>
      </UI.SheetContent>
    </UI.Sheet>
  )
}
