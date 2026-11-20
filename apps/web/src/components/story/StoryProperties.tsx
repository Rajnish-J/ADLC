'use client'

// The story's properties as label/value rows — Column (status), Assignee, Priority, Due date, Labels, Blocked —
// each editable in place when the API says the signed-in user may change it, and read-only otherwise. Every
// change saves at once.

import { useState, type ReactNode } from 'react'
import { Hand } from 'lucide-react'
import { STORY_PRIORITIES, STORY_STATUS_LABELS, type ProjectDetail, type Story, type StoryPriority } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PriorityBadge, StatusBadge } from '@/components/common/story-badges'
import { UserAvatar } from '@/components/common/user-avatar'
import { LatestRunChip } from '@/components/work/LatestRunChip'
import type { SaveStory } from '@/hooks/story/useStorySave'
import { cn } from '@/lib/utils'
import { assignStory, pickUpStory, updateStory } from '@/service/story.service'
import { dateTime, relativeTime } from '@/utils/format'
import { PRIORITY_DOT, PRIORITY_LABEL, STATUS_DOT } from '@/utils/status'
import { DueDateChip, LabelChip } from './StoryChips'
import { DueDatePicker, LabelsInput } from './StoryFieldInputs'
import { findMove, moveToast, performMove, storyMoves } from './story-moves'

const UNASSIGNED = '__unassigned__'

interface RowProps {
  story: Story
  busy: string | null
  save: SaveStory
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[6.5rem_1fr] items-center gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">{children}</div>
    </div>
  )
}

function ColumnRow({ story, busy, save }: RowProps) {
  const moves = storyMoves(story)
  if (moves.length === 0) return <Row label="Column">{<StatusBadge status={story.status} />}</Row>
  return (
    <Row label="Column">
      <Select
        value={story.status}
        disabled={busy !== null}
        onValueChange={(to) => {
          const move = findMove(story, to as Story['status'])
          if (move) void save('move', () => performMove(story, move.to), moveToast(story, move.to) ?? undefined)
        }}
      >
        <SelectTrigger size="sm" className="w-full max-w-52" aria-label="Column">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          <SelectItem value={story.status}>
            <span className={cn('size-2 rounded-full', STATUS_DOT[story.status])} aria-hidden />
            {STORY_STATUS_LABELS[story.status]}
          </SelectItem>
          {moves.map((m) => (
            <SelectItem key={m.to} value={m.to}>
              <span className={cn('size-2 rounded-full', STATUS_DOT[m.to])} aria-hidden />
              {STORY_STATUS_LABELS[m.to]}
              <span className="text-xs text-muted-foreground">· {m.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  )
}

function AssigneeRow({ story, project, busy, save }: RowProps & { project: ProjectDetail }) {
  if (story.actions.canAssign) {
    const assignable = project.members.filter((m) => m.role !== 'viewer')
    return (
      <Row label="Assignee">
        <Select
          value={story.assignee?.id ?? UNASSIGNED}
          disabled={busy !== null}
          onValueChange={(value) => {
            const userId = value === UNASSIGNED ? null : value
            void save('assign', () => assignStory(story.projectKey, story.number, userId), (s) =>
              s.assignee ? `${s.key} assigned to ${s.assignee.displayName}` : `${s.key} unassigned`,
            )
          }}
        >
          <SelectTrigger size="sm" className="w-full max-w-52" aria-label="Assignee">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
            {assignable.map((m) => (
              <SelectItem key={m.user.id} value={m.user.id}>
                <UserAvatar name={m.user.displayName} className="size-5" />
                {m.user.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    )
  }
  return (
    <Row label="Assignee">
      {story.assignee ? (
        <>
          <UserAvatar name={story.assignee.displayName} className="size-5" />
          <span className="truncate">{story.assignee.displayName}</span>
        </>
      ) : (
        <span className="text-muted-foreground italic">Unassigned</span>
      )}
      {story.actions.canPickUp ? (
        <Button
          size="xs"
          variant="outline"
          className="text-primary"
          disabled={busy !== null}
          onClick={() => void save('pickup', () => pickUpStory(story.projectKey, story.number), `You picked up ${story.key}`)}
        >
          {busy === 'pickup' ? <Spinner /> : <Hand />}
          Pick up
        </Button>
      ) : null}
    </Row>
  )
}

function PriorityRow({ story, busy, save }: RowProps) {
  // Priority is a lead's call — the same people who may assign the story (the API enforces it).
  if (!story.actions.canAssign) return <Row label="Priority">{<PriorityBadge priority={story.priority} />}</Row>
  return (
    <Row label="Priority">
      <Select
        value={story.priority}
        disabled={busy !== null}
        onValueChange={(value) => {
          const priority = value as StoryPriority
          void save('priority', () => updateStory(story.projectKey, story.number, { version: story.version, priority }), `Priority set to ${PRIORITY_LABEL[priority]}`)
        }}
      >
        <SelectTrigger size="sm" className="w-full max-w-52" aria-label="Priority">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {STORY_PRIORITIES.map((p) => (
            <SelectItem key={p} value={p}>
              <span className={cn('size-2 rounded-full', PRIORITY_DOT[p])} aria-hidden />
              {PRIORITY_LABEL[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  )
}

function DueDateRow({ story, busy, save }: RowProps) {
  // The due date is a lead's call, like priority (the API enforces it).
  if (!story.actions.canAssign) {
    return <Row label="Due date">{story.dueDate ? <DueDateChip story={story} /> : <span className="text-muted-foreground">No due date</span>}</Row>
  }
  return (
    <Row label="Due date">
      <DueDatePicker
        value={story.dueDate}
        done={story.status === 'done'}
        disabled={busy !== null}
        onChange={(dueDate) =>
          void save('dueDate', () => updateStory(story.projectKey, story.number, { version: story.version, dueDate }), dueDate ? 'Due date set' : 'Due date cleared')
        }
      />
    </Row>
  )
}

function LabelsRow({ story, busy, save, suggestions }: RowProps & { suggestions: string[] }) {
  if (!story.actions.canEdit) {
    return (
      <Row label="Labels">
        {story.labels.length > 0 ? story.labels.map((l) => <LabelChip key={l} label={l} />) : <span className="text-muted-foreground">None</span>}
      </Row>
    )
  }
  return (
    <Row label="Labels">
      <LabelsInput
        labels={story.labels}
        suggestions={suggestions}
        saving={busy !== null}
        onChange={(labels) => void save('labels', () => updateStory(story.projectKey, story.number, { version: story.version, labels }))}
      />
    </Row>
  )
}

function BlockedRow({ story, busy, save }: RowProps) {
  const [flagging, setFlagging] = useState(false)
  const [reason, setReason] = useState('')

  if (!story.actions.canEdit) {
    return (
      <Row label="Blocked">
        {story.isBlocked ? (
          <span className="text-destructive">{story.blockedReason || 'Yes'}</span>
        ) : (
          <span className="text-muted-foreground">No</span>
        )}
      </Row>
    )
  }

  function flag(): void {
    const blockedReason = reason.trim()
    if (!blockedReason) return
    void save('block', () => updateStory(story.projectKey, story.number, { version: story.version, isBlocked: true, blockedReason }), `${story.key} flagged as blocked`).then(
      (ok) => {
        if (ok) {
          setFlagging(false)
          setReason('')
        }
      },
    )
  }

  return (
    <Row label="Blocked">
      <Switch
        checked={story.isBlocked || flagging}
        disabled={busy !== null}
        aria-label="Blocked"
        onCheckedChange={(on) => {
          if (on) setFlagging(true)
          else if (story.isBlocked) void save('unblock', () => updateStory(story.projectKey, story.number, { version: story.version, isBlocked: false }), 'Blocker cleared')
          else setFlagging(false)
        }}
      />
      {story.isBlocked ? <span className="min-w-0 flex-1 truncate text-destructive">{story.blockedReason || 'No reason given'}</span> : null}
      {flagging && !story.isBlocked ? (
        <form
          className="flex w-full gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            flag()
          }}
        >
          <Input
            autoFocus
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What's in the way?"
            aria-label="Blocker reason"
            className="h-8"
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy !== null || !reason.trim()}>
            {busy === 'block' ? <Spinner /> : null}
            Flag
          </Button>
        </form>
      ) : null}
    </Row>
  )
}

interface Props extends RowProps {
  project: ProjectDetail
  /** Labels used elsewhere in the project, offered while adding one. */
  labelSuggestions?: string[]
}

export default function StoryProperties({ story, project, busy, save, labelSuggestions = [] }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <ColumnRow story={story} busy={busy} save={save} />
      <AssigneeRow story={story} project={project} busy={busy} save={save} />
      <PriorityRow story={story} busy={busy} save={save} />
      <DueDateRow story={story} busy={busy} save={save} />
      <LabelsRow story={story} busy={busy} save={save} suggestions={labelSuggestions} />
      <BlockedRow story={story} busy={busy} save={save} />
      {/* Picked when a run starts, not ahead of time: the workflow the story's latest run used. */}
      <Row label="Workflow">
        {story.latestRun ? <LatestRunChip projectKey={story.projectKey} run={story.latestRun} /> : <span className="text-muted-foreground">Not run yet</span>}
      </Row>
      <Row label="Updated">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground">{relativeTime(story.updatedAt)}</span>
          </TooltipTrigger>
          <TooltipContent>{dateTime(story.updatedAt)}</TooltipContent>
        </Tooltip>
      </Row>
    </div>
  )
}
