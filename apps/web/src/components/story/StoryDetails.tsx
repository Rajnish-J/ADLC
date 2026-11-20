'use client'

// The story's details card: assignee (a lead can change it), who created it, and when it last changed.

import type { ReactNode } from 'react'
import { toast } from 'sonner'
import type { ProjectDetail, Story } from '@sdlc/contracts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UserAvatar } from '@/components/common/user-avatar'
import { AppError } from '@/appError'
import { assignStory } from '@/service/story.service'
import { dateTime, relativeTime } from '@/utils/format'

const UNASSIGNED = '__unassigned__'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-2">{children}</span>
    </div>
  )
}

export function StoryDetails({ story, project, onChange }: { story: Story; project: ProjectDetail; onChange: (s: Story) => void }) {
  const assignable = project.members.filter((m) => m.role !== 'viewer')

  function assign(value: string): void {
    const userId = value === UNASSIGNED ? null : value
    assignStory(story.projectKey, story.number, userId)
      .then((s) => {
        onChange(s)
        toast.success(s.assignee ? `${story.key} assigned to ${s.assignee.displayName}` : `${story.key} unassigned`)
      })
      .catch((err) => toast.error(err instanceof AppError ? err.message : 'Could not change the assignee.'))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Row label="Assignee">
          {story.actions.canAssign ? (
            <Select value={story.assignee?.id ?? UNASSIGNED} onValueChange={assign}>
              <SelectTrigger size="sm" className="w-44" aria-label="Assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {assignable.map((m) => (
                  <SelectItem key={m.user.id} value={m.user.id}>
                    {m.user.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : story.assignee ? (
            <>
              <UserAvatar name={story.assignee.displayName} />
              <span className="truncate">{story.assignee.displayName}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          )}
        </Row>
        <Row label="Created by">
          <UserAvatar name={story.createdBy.displayName} />
          <span className="truncate">{story.createdBy.displayName}</span>
        </Row>
        <Row label="Updated">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{relativeTime(story.updatedAt)}</span>
            </TooltipTrigger>
            <TooltipContent>{dateTime(story.updatedAt)}</TooltipContent>
          </Tooltip>
        </Row>
      </CardContent>
    </Card>
  )
}
