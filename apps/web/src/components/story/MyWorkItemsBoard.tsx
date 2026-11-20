'use client'

// My work items: everything assigned to me in Azure DevOps, read live with my own token, on one board — a column
// per state category (New, Active, Resolved, Closed; every process maps its states onto these). Read-only: a card
// opens the work item in Azure DevOps, and a "Story" chip opens the platform story synced from it, if any.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ClipboardList, ExternalLink, KeyRound, RefreshCw } from 'lucide-react'
import {
  ADO_STATE_CATEGORIES,
  ADO_STATE_CATEGORY_LABELS,
  storyPriorityForAdo,
  type AdoBoardCategory,
  type MyWorkItem,
} from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { PriorityBadge } from '@/components/common/story-badges'
import { useAdoToken, useLinkAdoConnection, useMyWorkItems } from '@/hooks/story/useMyWorkItems'
import AdoConnectionSuggestions from './AdoConnectionSuggestions'
import { activeFilterCount, applyWorkItemFilters, NO_WORK_ITEM_FILTERS, WorkItemFilters, type WorkItemFilterState } from './WorkItemFilters'
import { cn } from '@/lib/utils'
import { shortAge } from '@/utils/format'

const COLUMN_DOT: Record<AdoBoardCategory, string> = {
  Proposed: 'bg-status-ready',
  InProgress: 'bg-status-in-progress',
  Resolved: 'bg-status-in-review',
  Completed: 'bg-status-done',
}

const FILTERS_KEY = 'sdlc.myWorkItems.filters'

/** The viewer's last filters (this browser only); never throws. */
function loadFilters(): WorkItemFilterState {
  try {
    const raw = window.localStorage.getItem(FILTERS_KEY)
    return raw ? { ...NO_WORK_ITEM_FILTERS, ...(JSON.parse(raw) as Partial<WorkItemFilterState>) } : NO_WORK_ITEM_FILTERS
  } catch {
    return NO_WORK_ITEM_FILTERS
  }
}

export default function MyWorkItemsBoard() {
  const { data, error, loading, reload } = useMyWorkItems()
  const [filters, setFilters] = useState<WorkItemFilterState>(NO_WORK_ITEM_FILTERS)
  useEffect(() => setFilters(loadFilters()), [])
  const changeFilters = (f: WorkItemFilterState): void => {
    setFilters(f)
    try {
      window.localStorage.setItem(FILTERS_KEY, JSON.stringify(f))
    } catch {
      /* storage unavailable: filters just aren't remembered */
    }
  }
  const items = data?.items
  const shown = useMemo(() => applyWorkItemFilters(items ?? [], filters), [items, filters])
  const columns = useMemo(() => {
    const out = Object.fromEntries(ADO_STATE_CATEGORIES.map((c) => [c, [] as MyWorkItem[]])) as Record<AdoBoardCategory, MyWorkItem[]>
    for (const item of shown) out[item.category].push(item)
    return out
  }, [shown])
  const filtering = activeFilterCount(filters) > 0
  const projectCount = useMemo(() => new Set((items ?? []).map((i) => i.project)).size, [items])
  const needsToken = error?.code === 'ado_token_missing'

  return (
    <>
      <UI.PageHeader
        title="My work items"
        description={
          data
            ? `${data.items.length} assigned to you in dev.azure.com/${data.organization}, across ${projectCount} ${projectCount === 1 ? 'project' : 'projects'}.`
            : 'Everything assigned to you in Azure DevOps, on one board.'
        }
        actions={
          needsToken ? null : (
            <UI.Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
              {loading ? <UI.Spinner /> : <RefreshCw />} Refresh
            </UI.Button>
          )
        }
      />

      {needsToken ? (
        <ConnectPrompt message={error.message} onConnected={reload} />
      ) : error ? (
        <UI.ErrorAlert title="Could not load your work items" message={error.message} />
      ) : loading && !data ? (
        <div className="flex gap-3 overflow-x-auto pb-3">
          {ADO_STATE_CATEGORIES.map((c) => (
            <UI.Skeleton key={c} className="h-[50vh] min-w-60 flex-1 rounded-xl" />
          ))}
        </div>
      ) : data && data.items.length === 0 ? (
        <UI.EmptyState icon={<ClipboardList />} title="Nothing assigned to you" description={`No open or closed work items are assigned to you in ${data.organization}.`} />
      ) : data ? (
        <div className="flex flex-col gap-2">
          <WorkItemFilters items={data.items} filters={filters} onFilters={changeFilters} />
          <div className="flex flex-wrap items-center gap-x-2 px-1 text-xs text-muted-foreground">
            {filtering ? (
              <span className="font-medium text-foreground">
                Showing {shown.length} of {data.items.length}
              </span>
            ) : null}
            <span>Updated {shortAge(data.fetchedAt) === 'now' ? 'just now' : `${shortAge(data.fetchedAt)} ago`}</span>
            {data.truncated ? <span>· only the {data.items.length} most recently changed are loaded</span> : null}
          </div>
          {/* Fixed height: each column scrolls on its own; the board scrolls sideways on narrow screens. */}
          <div className="flex h-[calc(100svh-17rem)] min-h-105 gap-3 overflow-x-auto pb-1">
            {ADO_STATE_CATEGORIES.map((c) => (
              <Column key={c} category={c} items={columns[c]} filtering={filtering} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

/**
 * No Azure DevOps access yet: offer the organisation's Git connections that hold my token ("Use this connection"),
 * else send me to Settings › Profile to add my own token.
 */
function ConnectPrompt({ message, onConnected }: { message: string; onConnected: () => Promise<void> }) {
  const { data } = useAdoToken()
  const { linking, link } = useLinkAdoConnection(() => onConnected())
  const suggestions = data?.suggestions ?? []
  const usable = suggestions.filter((s) => s.usable)
  return (
    <UI.EmptyState
      icon={<KeyRound />}
      title="Connect your Azure DevOps account"
      description={
        usable.length > 0
          ? `Your organization already has an Azure DevOps connection with your token. Use it to see your work items, or add your own token.`
          : message
      }
    >
      <div className="flex w-full flex-col items-center gap-3">
        <AdoConnectionSuggestions suggestions={suggestions} linking={linking} onUse={(id) => void link(id)} className="w-full sm:w-136" />
        <UI.Button asChild variant={usable.length > 0 ? 'outline' : 'default'}>
          <Link href="/settings/profile">{usable.length > 0 ? 'Add my own token instead' : 'Add your token'}</Link>
        </UI.Button>
      </div>
    </UI.EmptyState>
  )
}

function Column({ category, items, filtering }: { category: AdoBoardCategory; items: MyWorkItem[]; filtering: boolean }) {
  const label = ADO_STATE_CATEGORY_LABELS[category]
  return (
    <section aria-label={label} className="flex h-full min-h-0 min-w-64 flex-1 basis-0 flex-col rounded-xl border bg-muted/40">
      <header className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <span className={cn('size-2 rounded-full', COLUMN_DOT[category])} aria-hidden />
        <h2 className="text-sm font-semibold">{label}</h2>
        <span className="ml-auto min-w-6 rounded-full border bg-background px-1.5 text-center text-xs tabular-nums text-muted-foreground">{items.length}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2 pb-2 scrollbar-gutter-stable">
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">{filtering ? 'Nothing matches the filters' : 'No work items'}</p>
        ) : (
          items.map((item) => <WorkItemCard key={item.id} item={item} />)
        )}
      </div>
    </section>
  )
}

/** `Product Hub\Synfra\API` → `Synfra\API`; the project root itself keeps its name. */
const areaLabel = (path: string): string => (path.includes('\\') ? path.slice(path.indexOf('\\') + 1) : path)

function WorkItemCard({ item }: { item: MyWorkItem }) {
  return (
    <article className="group relative flex shrink-0 flex-col gap-2.5 rounded-xl border bg-card p-3 text-card-foreground shadow-xs transition-shadow hover:shadow-md focus-within:ring-2 focus-within:ring-ring/50">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <UI.Badge variant="outline" className="shrink-0">
            {item.type}
          </UI.Badge>
          <span className="font-mono text-[11px] font-medium text-muted-foreground">#{item.id}</span>
        </span>
        <span className="truncate text-xs text-muted-foreground" title={`State: ${item.state}`}>
          {item.state}
        </span>
      </div>
      <a href={item.url} target="_blank" rel="noreferrer" className="line-clamp-2 text-sm leading-snug font-semibold outline-none after:absolute after:inset-0 after:rounded-xl">
        {item.title}
        <ExternalLink className="ml-1 inline size-3 opacity-0 transition-opacity group-hover:opacity-60" aria-hidden />
        <span className="sr-only"> (opens in Azure DevOps)</span>
      </a>
      {item.priority !== null || item.tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {item.priority !== null ? <PriorityBadge priority={storyPriorityForAdo(item.priority)} /> : null}
          {item.tags.slice(0, 4).map((t) => (
            <UI.Badge key={t} variant="secondary" className="font-normal">
              {t}
            </UI.Badge>
          ))}
          {item.tags.length > 4 ? <span className="text-xs text-muted-foreground">+{item.tags.length - 4}</span> : null}
        </div>
      ) : null}
      {item.parent ? (
        <p className="truncate text-xs text-muted-foreground" title={`Parent: ${item.parent.id} ${item.parent.title}`}>
          ↳ <span className="font-mono">{item.parent.id}</span> {item.parent.title}
        </p>
      ) : null}
      <div className="flex min-h-6 items-center justify-between gap-2 border-t pt-2.5 text-xs text-muted-foreground">
        <span className="truncate" title={`Area ${item.areaPath} · ${item.iterationPath} · changed ${new Date(item.changedAt).toLocaleString()}`}>
          {areaLabel(item.areaPath || item.project)} · {shortAge(item.changedAt)}
        </span>
        {item.linkedStory ? (
          <Link
            href={`/projects/${item.linkedStory.projectKey}/stories/${item.linkedStory.number}`}
            className="relative z-10 shrink-0 rounded-md border bg-background px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent"
            title="The platform story synced from this work item"
          >
            {item.linkedStory.projectKey}-{item.linkedStory.number}
          </Link>
        ) : null}
      </div>
    </article>
  )
}
