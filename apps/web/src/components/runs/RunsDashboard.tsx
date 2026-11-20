'use client'

// Above the runs table: how runs are going across the project — runs, success rate, median duration and lines
// changed; runs per day by outcome; who runs them; how each harness does; and the files runs change most (a click
// filters the table to runs that touched that file). Collapsible, with a 7 / 30 / 90-day period.

import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { BarChart3, ChevronRight, FileCode2 } from 'lucide-react'
import { harnessLabel, type RunStats } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { useRunStats } from '@/hooks/runs/useRunRecords'
import { formatDuration } from './runFormat'

const PERIODS = [7, 30, 90] as const

const OUTCOMES: ChartConfig = {
  completed: { label: 'Completed', color: 'var(--success)' },
  failed: { label: 'Failed', color: 'var(--destructive)' },
  cancelled: { label: 'Cancelled / expired', color: 'var(--muted-foreground)' },
  other: { label: 'In progress', color: 'var(--chart-1)' },
}

const PEOPLE: ChartConfig = { runs: { label: 'Runs', color: 'var(--chart-1)' } }

const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`)
const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

function Totals({ stats }: { stats: RunStats }) {
  const t = stats.totals
  const ended = t.completed + t.failed
  const items: UI.StatItem[] = [
    {
      label: 'Runs',
      value: t.runs,
      badge: t.active ? { label: `${t.active} active`, variant: 'outline' } : undefined,
      footer: { title: `${t.completed} completed · ${t.failed} failed`, description: `Last ${stats.days} days` },
    },
    {
      label: 'Success rate',
      value: pct(t.successRate),
      footer: { title: ended ? `${t.completed} of ${ended} runs that ended` : 'No runs have ended yet', description: 'Completed vs failed (cancelled not counted)' },
    },
    {
      label: 'Median duration',
      value: t.medianDurationMs === null ? '—' : formatDuration(t.medianDurationMs),
      footer: { title: 'Of completed runs', description: 'Including time waiting for approvals' },
    },
    {
      label: 'Lines changed',
      value: (t.additions + t.deletions).toLocaleString(),
      footer: { title: `+${t.additions.toLocaleString()} −${t.deletions.toLocaleString()}`, description: `${t.filesChanged.toLocaleString()} file changes` },
    },
  ]
  return <UI.StatCards items={items} />
}

function PerDay({ stats }: { stats: RunStats }) {
  return (
    <UI.Card className="gap-3">
      <UI.CardHeader>
        <UI.CardTitle className="text-sm">Runs per day</UI.CardTitle>
        <UI.CardDescription>By outcome, when they started</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>
        <ChartContainer config={OUTCOMES} className="aspect-auto h-52 w-full">
          <BarChart data={stats.perDay} margin={{ left: -20, right: 4, top: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDate} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDate(String(v))} />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar isAnimationActive={false} dataKey="completed" stackId="a" fill="var(--color-completed)" stroke="var(--card)" strokeWidth={1.5} maxBarSize={28} />
            <Bar isAnimationActive={false} dataKey="failed" stackId="a" fill="var(--color-failed)" stroke="var(--card)" strokeWidth={1.5} maxBarSize={28} />
            <Bar isAnimationActive={false} dataKey="cancelled" stackId="a" fill="var(--color-cancelled)" stroke="var(--card)" strokeWidth={1.5} maxBarSize={28} />
            <Bar isAnimationActive={false} dataKey="other" stackId="a" fill="var(--color-other)" stroke="var(--card)" strokeWidth={1.5} radius={[4, 4, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ChartContainer>
      </UI.CardContent>
    </UI.Card>
  )
}

function PerPerson({ stats }: { stats: RunStats }) {
  const data = stats.perUser.slice(0, 8).map((u) => ({ name: u.user.displayName, runs: u.runs, completed: u.completed, failed: u.failed }))
  return (
    <UI.Card className="gap-3">
      <UI.CardHeader>
        <UI.CardTitle className="text-sm">Runs per person</UI.CardTitle>
        <UI.CardDescription>Who starts runs (top 8)</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>
        {data.length ? (
          <ChartContainer config={PEOPLE} className="aspect-auto w-full" style={{ height: Math.max(120, data.length * 34 + 24) }}>
            <BarChart data={data} layout="vertical" margin={{ left: 0, right: 24, top: 0, bottom: 0 }}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={110} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <Bar isAnimationActive={false} dataKey="runs" fill="var(--color-runs)" radius={[0, 4, 4, 0]} maxBarSize={18} label={{ position: 'right', className: 'fill-foreground text-xs' }} />
            </BarChart>
          </ChartContainer>
        ) : (
          <p className="text-sm text-muted-foreground">Nobody has run anything in this period.</p>
        )}
      </UI.CardContent>
    </UI.Card>
  )
}

function PerHarness({ stats }: { stats: RunStats }) {
  return (
    <UI.Card className="gap-3">
      <UI.CardHeader>
        <UI.CardTitle className="text-sm">By harness</UI.CardTitle>
        <UI.CardDescription>Completed vs failed runs, and their median duration</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-3">
        {stats.perHarness.length === 0 ? <p className="text-sm text-muted-foreground">No runs in this period.</p> : null}
        {stats.perHarness.map((h) => {
          const finished = h.completed + h.failed
          const rate = finished ? h.completed / finished : null
          return (
            <div key={h.engine ?? 'built-in'} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{h.engine ? harnessLabel(h.engine) : 'Built-in runtime'}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {h.runs} run{h.runs === 1 ? '' : 's'} · {pct(rate)} success{h.medianDurationMs !== null ? ` · ${formatDuration(h.medianDurationMs)}` : ''}
                </span>
              </div>
              <UI.Progress value={rate === null ? 0 : rate * 100} aria-label={`${h.engine ?? 'Built-in'} success rate`} />
            </div>
          )
        })}
      </UI.CardContent>
    </UI.Card>
  )
}

function Hotspots({ stats, onFile }: { stats: RunStats; onFile: (path: string) => void }) {
  const max = stats.hotspots[0]?.runs ?? 1
  return (
    <UI.Card className="gap-3">
      <UI.CardHeader>
        <UI.CardTitle className="text-sm">Most-changed files</UI.CardTitle>
        <UI.CardDescription>Click a file to see the runs that changed it</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-1">
        {stats.hotspots.length === 0 ? <p className="text-sm text-muted-foreground">No changed files reported yet.</p> : null}
        {stats.hotspots.map((h) => (
          <button
            key={h.path}
            type="button"
            onClick={() => onFile(h.path)}
            className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1 text-left text-xs hover:bg-muted"
            title={`Show runs that changed ${h.path}`}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-1.5 font-mono">
                <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate group-hover:text-primary">{h.path}</span>
              </span>
              <span className="h-1 rounded-full bg-chart-2/70" style={{ width: `${Math.max(6, (h.runs / max) * 100)}%` }} aria-hidden />
            </span>
            <span className="text-muted-foreground tabular-nums">
              {h.runs} run{h.runs === 1 ? '' : 's'}
            </span>
          </button>
        ))}
      </UI.CardContent>
    </UI.Card>
  )
}

export default function RunsDashboard({ projectKey, user, onFile }: { projectKey: string; user?: string; onFile: (path: string) => void }) {
  const [open, setOpen] = useState(true)
  const [days, setDays] = useState<number>(30)
  const { data: stats, error, loading } = useRunStats(projectKey, days, user)

  return (
    <UI.Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <UI.CollapsibleTrigger className="group flex items-center gap-2 text-sm font-medium">
          <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
          <BarChart3 className="size-4 text-muted-foreground" />
          Insights
          <span className="font-normal text-muted-foreground">
            · last {days} days{user ? ' · your runs' : ''}
          </span>
        </UI.CollapsibleTrigger>
        {open ? (
          <UI.ToggleGroup type="single" variant="outline" size="sm" value={String(days)} onValueChange={(v) => v && setDays(Number(v))} aria-label="Period">
            {PERIODS.map((p) => (
              <UI.ToggleGroupItem key={p} value={String(p)} className="px-3">
                {p}d
              </UI.ToggleGroupItem>
            ))}
          </UI.ToggleGroup>
        ) : null}
      </div>
      <UI.CollapsibleContent className="flex flex-col gap-4">
        {error ? <UI.ErrorAlert message={error.message} /> : null}
        {loading && !stats ? <UI.Skeleton className="h-36 rounded-xl" /> : null}
        {stats ? (
          <>
            <Totals stats={stats} />
            <div className="grid gap-4 @4xl/main:grid-cols-2">
              <PerDay stats={stats} />
              <PerPerson stats={stats} />
              <PerHarness stats={stats} />
              <Hotspots stats={stats} onFile={onFile} />
            </div>
          </>
        ) : null}
      </UI.CollapsibleContent>
    </UI.Collapsible>
  )
}
