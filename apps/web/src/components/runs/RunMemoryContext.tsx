'use client'

// What the agents worked from and what they left behind: the prompt or story (and task) they were given, each step's
// agent, skills and harness; the memory they were given (in the session's memory.md, or by asking for it) — each
// rated helpful or not by people, to improve memory over time; and the memory the run wrote, with how many later
// runs have been given it.

import { useState } from 'react'
import Link from 'next/link'
import { ArrowDownToLine, ArrowUpFromLine, Bot, Brain, Pin, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react'
import { harnessLabel, MEMORY_KIND_LABELS, type ProjectRunDetail, type RunMemoryUsed } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import MemoryContent from '@/components/memory/MemoryContent'
import { KIND_META, SOURCE_LABEL } from '@/components/memory/memory-meta'
import { setMemoryHelpful } from '@/service/runs.service'
import { plural } from './runFormat'

const STATUS_VARIANT = { accepted: 'success', proposed: 'warning', rejected: 'destructive', archived: 'secondary' } as const

function Context({ run }: { run: ProjectRunDetail }) {
  const ctx = run.context
  return (
    <UI.Card className="gap-4">
      <UI.CardHeader>
        <UI.CardTitle className="text-base">Given to the agents</UI.CardTitle>
        <UI.CardDescription>The work item and, for each step, the agent, its skills and the harness it ran in</UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent className="flex flex-col gap-4 text-sm">
        {ctx?.story ? (
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground uppercase">Story · story.md</h3>
            <p className="font-medium">
              {ctx.story.key} · {ctx.story.title}
            </p>
            {ctx.story.description ? <MemoryContent text={ctx.story.description} clampAt={400} /> : null}
          </section>
        ) : null}
        {ctx?.task ? (
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground uppercase">Task</h3>
            <p className="font-medium">
              {ctx.task.key} · {ctx.task.title}
            </p>
            {ctx.task.description ? <MemoryContent text={ctx.task.description} clampAt={300} /> : null}
          </section>
        ) : null}
        {ctx?.prompt ? (
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground uppercase">{ctx.story ? 'Additional instructions' : 'Prompt · prompt.md'}</h3>
            <p className="whitespace-pre-wrap">{ctx.prompt}</p>
          </section>
        ) : null}
        {ctx?.steps.length ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase">Steps</h3>
            <ol className="flex flex-col gap-2">
              {ctx.steps.map((s, i) => (
                <li key={s.nodeId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="w-5 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                  <span className="font-medium">{s.label}</span>
                  {s.agentName || s.agentSlug ? (
                    <UI.Badge variant="secondary">
                      <Bot /> {s.agentName ?? s.agentSlug}
                    </UI.Badge>
                  ) : null}
                  {s.harness ? <UI.Badge variant="outline">{harnessLabel(s.harness)}</UI.Badge> : null}
                  {s.skills.map((k) => (
                    <UI.Badge key={k} variant="outline" className="text-muted-foreground">
                      <Sparkles /> {k}
                    </UI.Badge>
                  ))}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {!ctx?.story && !ctx?.prompt && !ctx?.steps.length ? <p className="text-muted-foreground">Nothing recorded.</p> : null}
      </UI.CardContent>
    </UI.Card>
  )
}

function UsedItem({ projectKey, runId, item, onRated }: { projectKey: string; runId: string; item: RunMemoryUsed; onRated: () => void }) {
  const [helpful, setHelpful] = useState(item.helpful)
  const [busy, setBusy] = useState(false)
  const meta = KIND_META[item.kind]
  const Icon = meta.icon

  async function rate(value: boolean) {
    const next = helpful === value ? null : value
    setBusy(true)
    try {
      await setMemoryHelpful(projectKey, runId, item.id, next)
      setHelpful(next)
      onRated()
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not save the rating')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{item.title}</span>
          {item.pinned ? <Pin className="size-3.5 text-muted-foreground" aria-label="Pinned" /> : null}
        </span>
        <span className="flex items-center gap-1">
          <UI.Button
            variant={helpful === true ? 'secondary' : 'ghost'}
            size="icon-xs"
            aria-pressed={helpful === true}
            aria-label="Helpful for this run"
            title="Helpful for this run"
            disabled={busy}
            onClick={() => void rate(true)}
          >
            <ThumbsUp />
          </UI.Button>
          <UI.Button
            variant={helpful === false ? 'secondary' : 'ghost'}
            size="icon-xs"
            aria-pressed={helpful === false}
            aria-label="Not helpful for this run"
            title="Not helpful for this run"
            disabled={busy}
            onClick={() => void rate(false)}
          >
            <ThumbsDown />
          </UI.Button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <UI.Badge variant={meta.variant}>{MEMORY_KIND_LABELS[item.kind]}</UI.Badge>
        <span>{item.scope === 'story' ? `${item.storyKey ?? 'Story'} memory` : 'Project memory'}</span>
        <span>· {item.via === 'context' ? 'in memory.md at the start' : 'asked for by an agent'}</span>
      </div>
      <MemoryContent text={item.content} clampAt={240} />
    </li>
  )
}

export default function RunMemoryContext({ projectKey, run, onChanged }: { projectKey: string; run: ProjectRunDetail; onChanged: () => void }) {
  const { used, written, usedLater } = run.memory
  const memoryHref = (storyNumber: number | null) =>
    storyNumber ? `/projects/${projectKey}/stories/${storyNumber}?tab=memory` : `/projects/${projectKey}/memory`

  return (
    <div className="grid gap-4 @5xl/main:grid-cols-2">
      <div className="@5xl/main:col-span-2">
        <Context run={run} />
      </div>

      <UI.Card className="gap-2">
        <UI.CardHeader>
          <UI.CardTitle className="flex items-center gap-2 text-base">
            <ArrowDownToLine className="size-4 text-muted-foreground" /> Memory used
          </UI.CardTitle>
          <UI.CardDescription>
            {used.length ? `${plural(used.length, 'item')} the agents were given. Rate each one to improve what future runs get.` : 'The agents were given no memory.'}
          </UI.CardDescription>
        </UI.CardHeader>
        <UI.CardContent>
          {used.length ? (
            <ul className="divide-y">
              {used.map((m) => (
                <UsedItem key={m.id} projectKey={projectKey} runId={run.id} item={m} onRated={onChanged} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Runs record the memory they are given from now on. Pin project knowledge, or add conventions and decisions, so agents get it.
            </p>
          )}
        </UI.CardContent>
      </UI.Card>

      <UI.Card className="gap-2">
        <UI.CardHeader>
          <UI.CardTitle className="flex items-center gap-2 text-base">
            <ArrowUpFromLine className="size-4 text-muted-foreground" /> Memory written
          </UI.CardTitle>
          <UI.CardDescription>
            {written.length
              ? `${plural(written.length, 'item')}${usedLater ? ` · given to ${plural(usedLater, 'later run')}` : ''}`
              : 'Nothing yet. A summary is captured when the run completes.'}
          </UI.CardDescription>
        </UI.CardHeader>
        <UI.CardContent>
          {written.length ? (
            <ul className="divide-y">
              {written.map((m) => {
                const meta = KIND_META[m.kind]
                const Icon = meta.icon
                return (
                  <li key={m.id} className="flex flex-col gap-1.5 py-3">
                    <Link href={memoryHref(m.storyNumber)} className="flex min-w-0 items-center gap-2 font-medium hover:text-primary hover:underline">
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{m.title}</span>
                    </Link>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <UI.Badge variant={meta.variant}>{MEMORY_KIND_LABELS[m.kind]}</UI.Badge>
                      <UI.Badge variant={STATUS_VARIANT[m.status]}>{m.status === 'proposed' ? 'Proposed — awaiting a lead' : m.status}</UI.Badge>
                      <span>{m.scope === 'story' ? `${m.storyKey ?? 'Story'} memory` : 'Project memory'}</span>
                      {SOURCE_LABEL[m.source] ? <span>· {SOURCE_LABEL[m.source]}</span> : null}
                      {m.usedByRuns ? (
                        <span className="inline-flex items-center gap-1">
                          <Brain className="size-3" /> given to {plural(m.usedByRuns, 'later run')}
                        </span>
                      ) : null}
                    </div>
                    <MemoryContent text={m.content} clampAt={240} />
                  </li>
                )
              })}
            </ul>
          ) : null}
        </UI.CardContent>
      </UI.Card>
    </div>
  )
}
