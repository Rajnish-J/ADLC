'use client'

import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { ProjectDetail } from '@sdlc/contracts'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { StoryForm } from './StoryForm'

interface Props {
  project: ProjectDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** New story without leaving the board: the card appears in its column as soon as it's created. */
export default function NewStorySheet({ project, open, onOpenChange }: Props) {
  const router = useRouter()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>New user story</SheetTitle>
          <SheetDescription>
            Each story is a sub-project: a developer picks it up and works through it with {project.key}&apos;s agents.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-4 pb-6">
            <StoryForm
              project={project}
              onCancel={() => onOpenChange(false)}
              onCreated={(story) => {
                onOpenChange(false)
                toast.success(`${story.key} created`, {
                  description: story.title,
                  action: { label: 'Open', onClick: () => router.push(`/projects/${story.projectKey}/stories/${story.number}`) },
                })
              }}
            />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
