'use client'

// This attempt beside the previous one at the same story or task: outcome, time, size, gates and memory, then the
// files only this run changed, only the previous one changed, and both changed (with how the line counts moved).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { RUN_STATUS_LABELS, type ChangedFile, type ProjectRunDetail } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { runHref } from '@/components/work/RunComposerProvider'
import { RUN_VARIANT, runDuration } from '@/components/work/RunSteps'
import { getRunDetail } from '@/service/runs.service'
import { lineDelta } from './runFormat'

function filesOf(run: ProjectRunDetail): Map<string, ChangedFile> {
  const list = run.changes?.files ?? run.changedFiles.map((path) => ({ path, status: 'modified' as const, additions: 0, deletions: 0, binary: false, excluded: false }))
  return new Map(list.map((f) => [f.path, f]))
}

function Column({ projectKey, run, title }: { projectKey: string; run: ProjectRunDetail; title: string }) {
  const rows: [string, React.ReactNode][] = [
    ['Outcome', <UI.Badge key="s" variant={RUN_VARIANT[run.status]}>{RUN_STATUS_LABELS[run.status]}</UI.Badge>],
    ['Duration', runDuration(run.startedAt, run.finishedAt)],
    ['Changes', `${run.filesChanged} files · ${lineDelta(run.additions, run.deletions)}`],
    ['Gates', `${run.gatesPassed} passed · ${run.gatesFailed} failed`],
    ['Memory', `${run.memoryUsed} used · ${run.memoryWritten} written`],
    ['Harness', run.engine ?? 'Built-in'],
  ]
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
      <Link href={runHref(projectKey, run.id)} className="text-sm font-medium hover:text-primary hover:underline">
        {title} · attempt {run.attempt?.number ?? '?'}
      </Link>
      <span className="text-xs text-muted-foreground">
        {run.startedBy?.displayName ?? 'Someone'} · {UI.relativeTime(run.startedAt)}
      </span>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 truncate">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function FileList({ title, files, hint }: { title: string; files: { path: string; note?: string }[]; hint: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className="text-sm font-medium">
        {title} <span className="font-normal text-muted-foreground">({files.length})</span>
      </h3>
      {files.length ? (
        <ul className="max-h-40 overflow-y-auto rounded-md border font-mono text-xs">
          {files.map((f) => (
            <li key={f.path} className="flex justify-between gap-2 border-b px-2 py-1 last:border-0">
              <span className="truncate" title={f.path}>
                {f.path}
              </span>
              {f.note ? <span className="shrink-0 text-muted-foreground">{f.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </section>
  )
}

export default function CompareRunsDialog({
  projectKey,
  run,
  open,
  onOpenChange,
}: {
  projectKey: string
  run: ProjectRunDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const previousId = run.attempt?.previousId ?? null
  const [previous, setPrevious] = useState<ProjectRunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !previousId) return
    let live = true
    setError(null)
    getRunDetail(projectKey, previousId)
      .then((r) => live && setPrevious(r))
      .catch((err) => live && setError(err instanceof AppError ? err.message : 'Could not load the previous run'))
    return () => {
      live = false
    }
  }, [open, previousId, projectKey])

  const now = filesOf(run)
  const before = previous ? filesOf(previous) : new Map<string, ChangedFile>()
  const onlyNow = [...now.keys()].filter((p) => !before.has(p)).map((path) => ({ path }))
  const onlyBefore = [...before.keys()].filter((p) => !now.has(p)).map((path) => ({ path }))
  const both = [...now.keys()]
    .filter((p) => before.has(p))
    .map((path) => {
      const a = before.get(path)!
      const b = now.get(path)!
      const delta = b.additions + b.deletions - (a.additions + a.deletions)
      return { path, note: delta === 0 ? 'same size' : `${delta > 0 ? '+' : ''}${delta} lines` }
    })

  return (
    <UI.Dialog open={open} onOpenChange={onOpenChange}>
      <UI.DialogContent className="sm:max-w-3xl">
        <UI.DialogHeader>
          <UI.DialogTitle>Compare with the previous attempt</UI.DialogTitle>
          <UI.DialogDescription>Same {run.task ? 'task' : 'story'}, one attempt apart.</UI.DialogDescription>
        </UI.DialogHeader>
        {error ? <UI.ErrorAlert message={error} /> : null}
        {!previous && !error ? <UI.Skeleton className="h-48 rounded-lg" /> : null}
        {previous ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Column projectKey={projectKey} run={previous} title="Previous" />
              <Column projectKey={projectKey} run={run} title="This run" />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <FileList title="Only this run" files={onlyNow} hint="Nothing new." />
              <FileList title="Both" files={both} hint="No files in common." />
              <FileList title="Only the previous" files={onlyBefore} hint="Nothing dropped." />
            </div>
          </div>
        ) : null}
      </UI.DialogContent>
    </UI.Dialog>
  )
}
