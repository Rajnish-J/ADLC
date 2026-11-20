'use client'

// A workflow run's branch on the Code page (?run=<id>). The branch exists only in the user's VS Code — runs never
// push — so it is shown from what VS Code reported: the default branch's files with the run's changes laid over them,
// marked like VS Code's Source Control (M / A / D / R, and changed-file counts on folders), and a side-by-side diff
// for each changed file. Read-only; it updates live after every step the run completes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { FileDiff, GitBranch, GitCommitHorizontal, Laptop, ListFilter, X } from 'lucide-react'
import type { ProjectDetail, ProjectRepository } from '@sdlc/contracts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Skeleton } from '@/components/ui/skeleton'
import { Toggle } from '@/components/ui/toggle'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/utils/format'
import { useRepoFile } from '@/hooks/code/useCode'
import { useRunBranchDetail, useRunBranchFile, useRunBranchTree } from '@/hooks/code/useRunBranch'
import { runHref } from '@/components/work/RunComposerProvider'
import DiffView from '@/components/work/DiffView'
import FileExplorer from './FileExplorer'
import { CodeDiff, CodeEditor } from './Monaco'

function parentDirs(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

const CHANGE_BADGE = {
  modified: { label: 'Modified', className: 'text-amber-600 dark:text-amber-400' },
  added: { label: 'Added', className: 'text-emerald-600 dark:text-emerald-400' },
  deleted: { label: 'Deleted', className: 'text-red-600 dark:text-red-400' },
  renamed: { label: 'Renamed', className: 'text-teal-600 dark:text-teal-400' },
} as const

export default function RunBranchWorkbench({ project, repo, runId }: { project: ProjectDetail; repo: ProjectRepository | null; runId: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const path = params.get('path')
  const detail = useRunBranchDetail(project.key, runId)
  const tree = useRunBranchTree(project.key, runId)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(path ? parentDirs(path) : []))
  const [onlyChanged, setOnlyChanged] = useState(true)
  const d = detail.data

  const navigate = useCallback(
    (next: { path?: string | null; run?: string | null }) => {
      const q = new URLSearchParams(params.toString())
      if (next.run === null) q.delete('run')
      if (next.path === null) q.delete('path')
      else if (next.path !== undefined) q.set('path', next.path)
      router.replace(`${pathname}?${q.toString()}`, { scroll: false })
    },
    [params, pathname, router],
  )

  // Open the run's changed folders, so its files show at once.
  const changedDirs = useMemo(() => new Set((d?.changes ?? []).flatMap((c) => parentDirs(c.path))), [d])
  const shown = useMemo(() => (onlyChanged ? new Set([...expanded, ...changedDirs]) : expanded), [onlyChanged, expanded, changedDirs])
  const { folders, load } = tree
  const requested = useRef<Set<string>>(new Set())
  useEffect(() => {
    requested.current = new Set()
  }, [runId])
  useEffect(() => {
    for (const dir of shown) {
      if (folders.has(dir) || requested.current.has(dir)) continue
      requested.current.add(dir)
      void load(dir)
    }
  }, [shown, folders, load])

  const changed = d?.changes.find((c) => c.path === path) ?? null

  return (
    <div className="flex h-[calc(100svh-12.5rem)] min-h-[520px] flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="flex max-w-80 items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{d?.branch ?? '…'}</span>
        </span>
        <Badge variant="secondary" className="gap-1" title="The branch exists in the VS Code window that ran the workflow; it is never pushed.">
          <Laptop className="size-3" /> local · from VS Code
        </Badge>
        {d ? (
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span>
              {d.storyKey ? `${d.storyKey} · ` : ''}
              {d.files} file{d.files === 1 ? '' : 's'}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">+{d.additions}</span>
            <span className="text-red-600 dark:text-red-400">−{d.deletions}</span>
            {d.commits ? (
              <span className="hidden items-center gap-1 md:flex">
                <GitCommitHorizontal className="size-3.5" /> {d.commits} commit{d.commits === 1 ? '' : 's'}
              </span>
            ) : null}
            <span className="hidden lg:inline">· updated {relativeTime(d.updatedAt)}</span>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href={runHref(project.key, runId)}>Open run</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate({ run: null, path: null })}>
            <X /> Back to {repo?.defaultBranch ?? 'the repository'}
          </Button>
        </div>
      </div>

      {detail.error ? (
        <p className="p-6 text-sm text-destructive">{detail.error.message}</p>
      ) : (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="26%" minSize="12%" maxSize="50%" className="flex min-w-0 flex-col bg-muted/20">
            <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              {onlyChanged ? 'Changes' : 'Explorer'}
              <Toggle
                size="sm"
                pressed={onlyChanged}
                onPressedChange={setOnlyChanged}
                className="h-6 gap-1 px-1.5 text-[11px] font-normal normal-case"
                aria-label="Show only changed files"
              >
                <ListFilter className="size-3.5" /> Changed only
              </Toggle>
            </div>
            <div className="min-h-0 flex-1">
              <FileExplorer
                tree={tree}
                expanded={shown}
                onToggle={(dir) =>
                  setExpanded((s) => {
                    const next = new Set(s)
                    if (next.has(dir)) next.delete(dir)
                    else next.add(dir)
                    return next
                  })
                }
                activePath={path}
                onOpen={(p) => navigate({ path: p })}
                onlyChanged={onlyChanged}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="74%" minSize="40%" className="flex min-w-0 flex-col">
            {path ? (
              <>
                <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
                  <FileDiff className="size-3.5 text-muted-foreground" />
                  <span className="truncate font-mono">{path}</span>
                  {changed ? (
                    <>
                      <span className={cn('font-medium', CHANGE_BADGE[changed.change].className)}>{CHANGE_BADGE[changed.change].label}</span>
                      {changed.oldPath ? <span className="truncate text-muted-foreground">from {changed.oldPath}</span> : null}
                      <span className="ml-auto text-emerald-600 dark:text-emerald-400">+{changed.additions}</span>
                      <span className="text-red-600 dark:text-red-400">−{changed.deletions}</span>
                    </>
                  ) : (
                    <span className="ml-auto text-muted-foreground">Unchanged by the run</span>
                  )}
                </div>
                <div className="min-h-0 flex-1">
                  {changed ? (
                    <ChangedFile projectKey={project.key} runId={runId} path={path} version={d?.updatedAt ?? ''} />
                  ) : (
                    <BaseFile projectKey={project.key} branch={d?.baseBranch ?? repo?.defaultBranch ?? ''} path={path} />
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                <FileDiff className="size-6" />
                <p className="font-medium text-foreground">Pick a changed file</p>
                <p className="max-w-sm">
                  The run’s work on <span className="font-mono">{d?.branch}</span>, compared with where it started. It updates after every step the run completes.
                </p>
              </div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  )
}

/** A file the run changed: side by side, or — when its text was too large to report — its part of the run's diff. */
function ChangedFile({ projectKey, runId, path, version }: { projectKey: string; runId: string; path: string; version: string }) {
  const file = useRunBranchFile(projectKey, runId, path)
  const f = file.data
  if (file.error) return <p className="p-4 text-sm text-destructive">{file.error.message}</p>
  if (!f || f.path !== path) return <Skeleton className="h-full w-full rounded-none" />
  if (f.truncated) {
    return (
      <div className="h-full overflow-auto p-4">
        {f.patch ? (
          <DiffView patch={f.patch} />
        ) : (
          <p className="text-sm text-muted-foreground">{f.binary ? 'A binary file — no text to compare.' : 'This file is too large to show, and its diff was not shared.'}</p>
        )}
      </div>
    )
  }
  // Model paths are per run and per report, so Monaco never shows another run's (or an older report's) text.
  return <CodeDiff key={`${runId}:${path}:${version}`} path={`run-${runId}-${Date.parse(version) || 0}/${path}`} original={f.original ?? ''} modified={f.modified ?? ''} />
}

/** A file the run did not touch: the default branch's version. */
function BaseFile({ projectKey, branch, path }: { projectKey: string; branch: string; path: string }) {
  const file = useRepoFile(projectKey, branch, branch ? path : null)
  if (file.error) return <p className="p-4 text-sm text-destructive">{file.error.message}</p>
  if (!file.data) return <Skeleton className="h-full w-full rounded-none" />
  if (file.data.content === null) return <p className="p-4 text-sm text-muted-foreground">This file’s contents are not stored ({file.data.status}).</p>
  return <CodeEditor path={`${branch}/${path}`} value={file.data.content} readOnly />
}
