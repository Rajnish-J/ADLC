'use client'

// Board toolbar: search, assignee, priority, labels and a refresh button. The Board / Table switch lives in the page
// header, next to "New story".

import type { ReactNode } from 'react'
import { RefreshCw, Search, ShieldAlert, Tag, Users } from 'lucide-react'
import { STORY_PRIORITIES, type ProjectDetail, type Story, type StoryPriority } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { MultiSelectFilter } from '@/components/common/multi-select-filter'
import { cn } from '@/lib/utils'
import { PRIORITY_DOT, PRIORITY_LABEL } from '@/utils/status'

export type BoardView = 'board' | 'list'

export interface BoardFilterState {
  search: string
  assignee: string // 'all' | 'unassigned' | 'me' | userId
  priorities: StoryPriority[]
  /** A story matches when it has any of these labels. */
  labels: string[]
}

export const NO_FILTERS: BoardFilterState = { search: '', assignee: 'all', priorities: [], labels: [] }

/** Every label used on the board, alphabetically — the Labels filter and the drawer's suggestions. */
export function boardLabels(stories: Story[]): string[] {
  return [...new Set(stories.flatMap((s) => s.labels))].sort()
}

export function applyFilters(stories: Story[], f: BoardFilterState, myId: string | undefined): Story[] {
  const q = f.search.trim().toLowerCase()
  return stories.filter((s) => {
    if (q && !`${s.key} ${s.title} ${s.assignee?.displayName ?? ''} ${s.labels.join(' ')}`.toLowerCase().includes(q)) return false
    if (f.priorities.length > 0 && !f.priorities.includes(s.priority)) return false
    if (f.labels.length > 0 && !s.labels.some((l) => f.labels.includes(l))) return false
    if (f.assignee === 'unassigned') return s.assignee === null
    if (f.assignee === 'me') return Boolean(myId) && s.assignee?.id === myId
    if (f.assignee !== 'all') return s.assignee?.id === f.assignee
    return true
  })
}

const PRIORITY_OPTIONS = STORY_PRIORITIES.map((p) => ({
  value: p,
  label: PRIORITY_LABEL[p],
  icon: <span className={cn('size-2 rounded-full', PRIORITY_DOT[p])} aria-hidden />,
}))

interface Props {
  project: ProjectDetail
  filters: BoardFilterState
  onFilters: (f: BoardFilterState) => void
  /** Labels in use on the board (the Labels filter is hidden until there are some). */
  labels: string[]
  onRefresh: () => void
  refreshing: boolean
  /** Extra controls before the refresh button (e.g. "Sync from Azure DevOps"). */
  actions?: ReactNode
}

export function BoardFilters({ project, filters, onFilters, labels, onRefresh, refreshing, actions }: Props) {
  const assignable = project.members.filter((m) => m.role !== 'viewer')
  return (
    <div className="flex flex-col gap-2 @3xl/main:flex-row @3xl/main:items-center">
      <InputGroup className="@3xl/main:flex-1">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          placeholder={`Search title, ${project.key}-12 or assignee…`}
          value={filters.search}
          onChange={(e) => onFilters({ ...filters, search: e.target.value })}
          aria-label="Search stories"
        />
      </InputGroup>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filters.assignee} onValueChange={(assignee) => onFilters({ ...filters, assignee })}>
          <SelectTrigger className="w-48" aria-label="Assignee">
            <Users className="text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All assignees</SelectItem>
            <SelectItem value="me">Assigned to me</SelectItem>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {assignable.length > 0 ? <SelectSeparator /> : null}
            {assignable.map((m) => (
              <SelectItem key={m.user.id} value={m.user.id}>
                {m.user.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <MultiSelectFilter
          label="Priority"
          icon={<ShieldAlert />}
          options={PRIORITY_OPTIONS}
          selected={filters.priorities}
          onChange={(values) => onFilters({ ...filters, priorities: values as StoryPriority[] })}
        />
        {labels.length > 0 || filters.labels.length > 0 ? (
          <MultiSelectFilter
            label="Labels"
            icon={<Tag />}
            options={labels.map((l) => ({ value: l, label: l }))}
            selected={filters.labels}
            onChange={(values) => onFilters({ ...filters, labels: values })}
          />
        ) : null}
        {actions}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon" onClick={onRefresh} disabled={refreshing} aria-label="Refresh the board">
              <RefreshCw className={cn(refreshing && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
