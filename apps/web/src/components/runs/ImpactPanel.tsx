'use client'

// What the run's changes touch, worked out from its files: lines added and removed in each area of the codebase,
// what kind of files they are, how the files changed, and what a reviewer should look at first.

import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { AlertOctagon, AlertTriangle, ChevronRight, Info } from 'lucide-react'
import type { ChangedFile } from '@sdlc/contracts'
import { classifyRunImpact, IMPACT_CATEGORY_LABELS, type ImpactCategory, type RiskSeverity, type RunImpact } from '@sdlc/core'
import * as UI from '@/imports/UI.imports'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { lineDelta, plural } from './runFormat'

const LINES: ChartConfig = {
  additions: { label: 'Added', color: 'var(--success)' },
  deletions: { label: 'Removed', color: 'var(--destructive)' },
}

/**
 * Fixed per category, never by rank — a category keeps its color whatever else changed. The five main kinds get the
 * chart hues; the rest share one muted "other" color and are told apart by their labels.
 */
const CATEGORY_COLOR: Record<ImpactCategory, string> = {
  source: 'var(--chart-1)',
  ui: 'var(--chart-2)',
  tests: 'var(--chart-3)',
  database: 'var(--chart-4)',
  api: 'var(--chart-5)',
  dependencies: 'var(--muted-foreground)',
  config: 'var(--muted-foreground)',
  ci: 'var(--muted-foreground)',
  docs: 'var(--muted-foreground)',
  assets: 'var(--muted-foreground)',
}

const SIZE_LABEL: Record<RunImpact['size'], string> = { none: 'No changes', xs: 'Tiny', s: 'Small', m: 'Medium', l: 'Large', xl: 'Very large' }

const SEVERITY: Record<RiskSeverity, { icon: typeof Info; className: string; label: string }> = {
  high: { icon: AlertOctagon, className: 'text-destructive', label: 'High' },
  medium: { icon: AlertTriangle, className: 'text-warning-foreground dark:text-warning', label: 'Medium' },
  low: { icon: Info, className: 'text-muted-foreground', label: 'Low' },
}

function Areas({ impact }: { impact: RunImpact }) {
  const data = impact.areas.slice(0, 8)
  return (
    <ChartContainer config={LINES} className="aspect-auto w-full" style={{ height: Math.max(140, data.length * 34 + 48) }}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 12, top: 0, bottom: 0 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="area" tickLine={false} axisLine={false} width={130} tick={{ fontFamily: 'var(--font-mono)' }} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar isAnimationActive={false} dataKey="additions" stackId="l" fill="var(--color-additions)" stroke="var(--card)" strokeWidth={1.5} maxBarSize={18} />
        <Bar isAnimationActive={false} dataKey="deletions" stackId="l" fill="var(--color-deletions)" stroke="var(--card)" strokeWidth={1.5} radius={[0, 4, 4, 0]} maxBarSize={18} />
      </BarChart>
    </ChartContainer>
  )
}

function Kinds({ impact }: { impact: RunImpact }) {
  const total = impact.categories.reduce((n, c) => n + c.files, 0) || 1
  const statuses = [
    ['added', 'New'],
    ['modified', 'Modified'],
    ['deleted', 'Deleted'],
    ['renamed', 'Renamed'],
    ['other', 'Other'],
  ] as const
  return (
    <div className="flex flex-col gap-4">
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Files by kind">
        {impact.categories.map((c) => (
          <span key={c.category} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flexGrow: c.files, background: CATEGORY_COLOR[c.category] }} title={`${IMPACT_CATEGORY_LABELS[c.category]}: ${c.files}`} />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {impact.categories.map((c) => (
          <li key={c.category} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <span className="size-2.5 rounded-sm" style={{ background: CATEGORY_COLOR[c.category] }} aria-hidden />
              {IMPACT_CATEGORY_LABELS[c.category]}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {c.files} · {Math.round((c.files / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-1.5">
        {statuses.map(([key, label]) =>
          impact.byStatus[key] ? (
            <UI.Badge key={key} variant="outline" className="tabular-nums">
              {label} {impact.byStatus[key]}
            </UI.Badge>
          ) : null,
        )}
      </div>
    </div>
  )
}

function Risks({ impact }: { impact: RunImpact }) {
  if (!impact.risks.length) {
    return <p className="text-sm text-muted-foreground">Nothing stands out: no migrations, pipelines, secrets, dependency or large changes.</p>
  }
  return (
    <ul className="flex flex-col gap-2">
      {impact.risks.map((r) => {
        const s = SEVERITY[r.severity]
        const Icon = s.icon
        return (
          <li key={r.id}>
            <UI.Collapsible className="rounded-lg border">
              <UI.CollapsibleTrigger className="group flex w-full items-start gap-2.5 p-2.5 text-left">
                <Icon className={UI.cn('mt-0.5 size-4 shrink-0', s.className)} aria-label={`${s.label} severity`} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{r.label}</span>
                  <span className="text-xs text-muted-foreground">{r.detail}</span>
                </span>
                <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              </UI.CollapsibleTrigger>
              <UI.CollapsibleContent className="border-t px-2.5 py-2">
                <ul className="flex flex-col gap-0.5 font-mono text-xs">
                  {r.files.map((f) => (
                    <li key={f} className="truncate" title={f}>
                      {f}
                    </li>
                  ))}
                </ul>
              </UI.CollapsibleContent>
            </UI.Collapsible>
          </li>
        )
      })}
    </ul>
  )
}

export default function ImpactPanel({ files, fallbackPaths }: { files: ChangedFile[] | null; fallbackPaths: string[] }) {
  // Older runs only have paths: classify those without line counts.
  const list = useMemo<ChangedFile[]>(
    () => files ?? fallbackPaths.map((path) => ({ path, status: 'modified' as const, additions: 0, deletions: 0, binary: false, excluded: false })),
    [files, fallbackPaths],
  )
  const impact = useMemo(() => classifyRunImpact(list), [list])

  if (!list.length) {
    return (
      <UI.Card>
        <UI.CardHeader>
          <UI.CardTitle className="text-base">Impact</UI.CardTitle>
          <UI.CardDescription>No file changes were reported for this run.</UI.CardDescription>
        </UI.CardHeader>
      </UI.Card>
    )
  }

  return (
    <UI.Card className="gap-4">
      <UI.CardHeader>
        <UI.CardTitle className="text-base">Impact</UI.CardTitle>
        <UI.CardDescription>
          {plural(impact.files, 'file')} · {lineDelta(impact.additions, impact.deletions)} lines · {plural(impact.areas.length, 'area')}
        </UI.CardDescription>
        <UI.CardAction>
          <UI.Badge variant={impact.size === 'xl' || impact.size === 'l' ? 'warning' : 'secondary'}>{SIZE_LABEL[impact.size]} change</UI.Badge>
        </UI.CardAction>
      </UI.CardHeader>
      <UI.CardContent className="grid gap-6 @4xl/main:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-medium">Where it changed</h3>
          {files ? <Areas impact={impact} /> : <p className="text-sm text-muted-foreground">Line counts weren’t reported for this run.</p>}
        </section>
        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-medium">What kind of change</h3>
          <Kinds impact={impact} />
        </section>
        <section className="flex min-w-0 flex-col gap-2 @4xl/main:col-span-2">
          <h3 className="text-sm font-medium">Review first</h3>
          <Risks impact={impact} />
        </section>
      </UI.CardContent>
    </UI.Card>
  )
}
