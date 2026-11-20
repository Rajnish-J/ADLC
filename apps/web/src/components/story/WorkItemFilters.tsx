'use client'

// The My work items filter bar, like Azure DevOps': a keyword box, then Types, States, Area, Iteration, Tags and
// Parent work item — each a multi-select built from the items on the board (with how many have each value), and ✕
// to clear them all. Filters within one dropdown are OR, across dropdowns AND.

import { Filter, X } from 'lucide-react'
import type { MyWorkItem } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { MultiSelectFilter, type FilterOption } from '@/components/common/multi-select-filter'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export interface WorkItemFilterState {
  search: string
  types: string[]
  states: string[]
  areas: string[]
  iterations: string[]
  tags: string[]
  /** Parent work item ids, as text. */
  parents: string[]
}

export const NO_WORK_ITEM_FILTERS: WorkItemFilterState = { search: '', types: [], states: [], areas: [], iterations: [], tags: [], parents: [] }

export function activeFilterCount(f: WorkItemFilterState): number {
  return (f.search.trim() ? 1 : 0) + f.types.length + f.states.length + f.areas.length + f.iterations.length + f.tags.length + f.parents.length
}

const any = (picked: string[], value: string): boolean => picked.length === 0 || picked.includes(value)

export function applyWorkItemFilters(items: MyWorkItem[], f: WorkItemFilterState): MyWorkItem[] {
  const q = f.search.trim().toLowerCase()
  return items.filter(
    (i) =>
      (!q || `#${i.id} ${i.id} ${i.title} ${i.type} ${i.state} ${i.areaPath} ${i.tags.join(' ')} ${i.parent?.title ?? ''}`.toLowerCase().includes(q)) &&
      any(f.types, i.type) &&
      any(f.states, i.state) &&
      any(f.areas, i.areaPath) &&
      any(f.iterations, i.iterationPath) &&
      (f.tags.length === 0 || i.tags.some((t) => f.tags.includes(t))) &&
      any(f.parents, i.parent ? String(i.parent.id) : ''),
  )
}

/** `Product Hub\Synfra\API` → `Synfra\API`; the project root itself keeps its name. */
const withoutRoot = (path: string): string => (path.includes('\\') ? path.slice(path.indexOf('\\') + 1) : path)

/** Distinct values with counts, most common first (then alphabetically). */
function optionsOf(items: MyWorkItem[], pick: (i: MyWorkItem) => Array<{ value: string; label: string; title?: string }>, sort: 'count' | 'label' = 'count'): FilterOption[] {
  const map = new Map<string, FilterOption & { count: number }>()
  for (const item of items) {
    for (const o of pick(item)) {
      const hit = map.get(o.value)
      if (hit) hit.count++
      else map.set(o.value, { ...o, count: 1 })
    }
  }
  return [...map.values()].sort((a, b) => (sort === 'count' ? b.count - a.count : 0) || a.label.localeCompare(b.label, undefined, { numeric: true }))
}

interface Props {
  items: MyWorkItem[]
  filters: WorkItemFilterState
  onFilters: (f: WorkItemFilterState) => void
}

export function WorkItemFilters({ items, filters, onFilters }: Props) {
  const set = (patch: Partial<WorkItemFilterState>) => onFilters({ ...filters, ...patch })
  const active = activeFilterCount(filters)
  const dropdowns: Array<{ key: keyof Omit<WorkItemFilterState, 'search'>; label: string; options: FilterOption[]; wide?: boolean }> = [
    { key: 'types', label: 'Types', options: optionsOf(items, (i) => [{ value: i.type, label: i.type }]) },
    { key: 'states', label: 'States', options: optionsOf(items, (i) => [{ value: i.state, label: i.state }]) },
    { key: 'areas', label: 'Area', options: optionsOf(items, (i) => [{ value: i.areaPath, label: withoutRoot(i.areaPath), title: i.areaPath }], 'label'), wide: true },
    {
      key: 'iterations',
      label: 'Iteration',
      options: optionsOf(items, (i) => [{ value: i.iterationPath, label: withoutRoot(i.iterationPath), title: i.iterationPath }], 'label'),
      wide: true,
    },
    { key: 'tags', label: 'Tags', options: optionsOf(items, (i) => i.tags.map((t) => ({ value: t, label: t }))) },
    {
      key: 'parents',
      label: 'Parent Work Item',
      options: optionsOf(items, (i) => (i.parent ? [{ value: String(i.parent.id), label: `${i.parent.id} ${i.parent.title}`, title: i.parent.title }] : [])),
      wide: true,
    },
  ]

  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-muted/50 p-1 @3xl/main:flex-row @3xl/main:items-center">
      <label className="flex min-w-0 flex-1 items-center gap-2 px-2">
        <Filter className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder="Filter by keyword"
          aria-label="Filter by keyword"
          className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </label>
      <div className="flex flex-wrap items-center gap-0.5">
        {dropdowns.map((d) =>
          d.options.length > 0 || filters[d.key].length > 0 ? (
            <MultiSelectFilter
              key={d.key}
              variant="ghost"
              label={d.label}
              options={d.options}
              selected={filters[d.key]}
              onChange={(values) => set({ [d.key]: values })}
              contentClassName={d.wide ? 'w-80' : undefined}
            />
          ) : null,
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => onFilters(NO_WORK_ITEM_FILTERS)} disabled={active === 0} aria-label="Clear all filters">
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Clear filters</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
