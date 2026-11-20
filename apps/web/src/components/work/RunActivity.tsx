'use client'

// A run's activity timeline, live while it runs: steps starting and finishing, the agents the harness ran, the
// skills they used, tool calls, files touched, plans, approvals and memory — grouped by step.

import { Activity, Bot, CheckCircle2, FileCode, Hammer, Lightbulb, MessageSquare, Play, ShieldCheck, Sparkles, StickyNote } from 'lucide-react'
import { RUN_EVENT_LABELS, type RunEvent, type RunEventType, type StoryRunStep } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { useRunEvents } from '@/hooks/work/useHarnessRuns'

const ICON: Partial<Record<RunEventType, typeof Activity>> = {
  'session.started': Play,
  'harness.opened': Play,
  'step.started': Play,
  'step.completed': CheckCircle2,
  'plan.submitted': Lightbulb,
  'approval.requested': MessageSquare,
  'approval.decided': MessageSquare,
  'agent.started': Bot,
  'agent.stopped': Bot,
  'skill.used': Sparkles,
  'tool.called': Hammer,
  'tool.failed': Hammer,
  'file.changed': FileCode,
  'memory.read': StickyNote,
  'memory.written': StickyNote,
  'gate.evaluated': ShieldCheck,
}

function describe(e: RunEvent): string {
  const bits = [
    e.agentName ?? e.agentType,
    e.skill ? `skill ${e.skill}` : null,
    e.tool,
    e.path,
  ].filter(Boolean)
  return e.summary ?? bits.join(' · ')
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export default function RunActivity({ projectKey, runId, steps }: { projectKey: string; runId: string; steps: StoryRunStep[] }) {
  const { data, error, loading } = useRunEvents(projectKey, runId)
  if (error) return <UI.ErrorAlert message={error.message} />
  if (loading && !data) return <UI.Skeleton className="h-48 rounded-xl" />
  const events = data?.events ?? []
  if (events.length === 0) {
    return (
      <UI.EmptyState
        icon={<Activity />}
        title="No activity reported"
        description="Runs in a harness report their agents, skills, tool calls and files here. Runs in the built-in runtime show their steps only."
      />
    )
  }
  const labels = new Map(steps.map((s) => [s.stepId, s.label]))
  const groups: { stepId: string | null; events: RunEvent[] }[] = []
  for (const e of events) {
    const last = groups[groups.length - 1]
    if (last && last.stepId === e.stepId) last.events.push(e)
    else groups.push({ stepId: e.stepId, events: [e] })
  }
  const toolCalls = events.filter((e) => e.type === 'tool.called').length
  const skills = [...new Set(events.flatMap((e) => (e.skill ? [e.skill] : [])))]
  const files = [...new Set(events.flatMap((e) => (e.type === 'file.changed' && e.path ? [e.path] : [])))]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <UI.Badge variant="secondary">{plural(events.length, 'event')}</UI.Badge>
        <UI.Badge variant="outline">{plural(toolCalls, 'tool call')}</UI.Badge>
        <UI.Badge variant="outline">{plural(files.length, 'file')}</UI.Badge>
        {skills.map((s) => (
          <UI.Badge key={s} variant="outline">
            <Sparkles /> {s}
          </UI.Badge>
        ))}
      </div>
      {groups.map((g, i) => (
        <section key={`${g.stepId}-${i}`} className="flex flex-col">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">{g.stepId ? (labels.get(g.stepId) ?? g.stepId) : 'Session'}</h4>
          <ol className="flex flex-col border-l">
            {g.events.map((e) => {
              const Icon = ICON[e.type] ?? Activity
              return (
                <li key={e.seq} className="flex items-start gap-2 py-1 pl-3 text-xs">
                  <Icon className={UI.cn('mt-0.5 size-3.5 shrink-0', e.type === 'tool.failed' ? 'text-destructive' : 'text-muted-foreground')} />
                  <span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">{time(e.at)}</span>
                  <span className="shrink-0 whitespace-nowrap font-medium">{RUN_EVENT_LABELS[e.type]}</span>
                  <span className={UI.cn('min-w-0 truncate text-muted-foreground', e.path && 'font-mono')} title={describe(e)}>
                    {describe(e)}
                  </span>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}
