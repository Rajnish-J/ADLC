'use client'

// The VS Code-like workbench: branch switcher and quick open on top, the explorer on the left, tabs and Monaco on
// the right. State that matters across reloads (branch, open file) lives in the URL: ?branch=…&path=….

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { FilePlus, GitCommitHorizontal, Loader } from 'lucide-react'
import { toast } from 'sonner'
import type { ProjectDetail, ProjectRepository, RepoBranch } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Spinner } from '@/components/ui/spinner'
import { relativeTime } from '@/utils/format'
import { useDrafts, useRepoFile } from '@/hooks/code/useCode'
import { useCodeTree } from '@/hooks/code/useCodeTree'
import { useRunBranches } from '@/hooks/code/useRunBranch'
import { createBranch, createRepoFile, deleteRepoFile, discardDraft, openBranch, saveDraft } from '@/service/code.service'
import BranchSwitcher from './BranchSwitcher'
import CommitDialog from './CommitDialog'
import EditorArea, { isDirty, type EditState } from './EditorArea'
import FileExplorer from './FileExplorer'
import NewFileDialog from './NewFileDialog'
import QuickOpen from './QuickOpen'

interface Props {
  project: ProjectDetail
  repo: ProjectRepository
  branches: RepoBranch[]
}

function parentDirs(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

export default function CodeWorkbench({ project, repo, branches }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const canEdit = project.permissions.includes('code.edit')
  const workspace = repo.provider === 'workspace'

  const requested = params.get('branch')
  const branchName = requested && branches.some((b) => b.name === requested) ? requested : (repo.defaultBranch ?? branches[0]?.name ?? '')
  const branch = branches.find((b) => b.name === branchName)
  const ready = Boolean(branch?.indexedSha)
  const path = params.get('path')
  const line = Number(params.get('line')) || undefined

  const [tabs, setTabs] = useState<string[]>(path ? [path] : [])
  const [edits, setEdits] = useState<Record<string, EditState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(path ? parentDirs(path) : []))
  const [busy, setBusy] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [newFileOpen, setNewFileOpen] = useState(false)

  const tree = useCodeTree(project.key, branchName, ready)
  const runBranches = useRunBranches(project.key, true)
  const drafts = useDrafts(project.key, branchName, canEdit && ready)
  const file = useRepoFile(project.key, branchName, ready ? path : null)
  const edit = path ? edits[path] : undefined

  const navigate = useCallback(
    (next: { branch?: string; path?: string | null }) => {
      const q = new URLSearchParams(params.toString())
      q.delete('line')
      if (next.branch !== undefined) q.set('branch', next.branch)
      if (next.path === null) q.delete('path')
      else if (next.path !== undefined) q.set('path', next.path)
      router.replace(`${pathname}?${q.toString()}`, { scroll: false })
    },
    [params, pathname, router],
  )

  // Load the folders leading to a file opened from a link (once each, even if one fails).
  const requestedDirs = useRef<Set<string>>(new Set())
  const { folders, load: loadDir } = tree
  useEffect(() => {
    if (!ready) return
    for (const d of expanded) {
      if (folders.has(d) || requestedDirs.current.has(d)) continue
      requestedDirs.current.add(d)
      void loadDir(d)
    }
  }, [ready, expanded, folders, loadDir])
  useEffect(() => {
    requestedDirs.current = new Set()
  }, [branchName])

  // A saved draft re-opens in edit mode.
  const f = file.data && file.data.path === path ? file.data : null
  useEffect(() => {
    if (!f || !path || edits[path] || !f.draft) return
    setEdits((m) => ({ ...m, [path]: { mode: 'edit', buffer: f.draft!.content, saved: f.draft!.content, baseBlobSha: f.draft!.baseBlobSha } }))
  }, [f, path, edits])

  // Opening a branch nobody loaded yet asks the server to index it.
  useEffect(() => {
    if (branch && !branch.indexedSha && !branch.indexing) {
      openBranch(project.key, branch.name).catch((err) => toast.error(err instanceof AppError ? err.message : 'Could not open the branch.'))
    }
  }, [branch, project.key])

  function openFile(p: string): void {
    setTabs((t) => (t.includes(p) ? t : [...t, p]))
    setExpanded((s) => new Set([...s, ...parentDirs(p)]))
    navigate({ path: p })
  }

  function closeTab(p: string): void {
    if (isDirty(edits[p]) && !window.confirm(`Close ${p.split('/').pop()} without saving your changes?`)) return
    setEdits(({ [p]: _closed, ...rest }) => rest)
    setTabs((t) => {
      const next = t.filter((x) => x !== p)
      if (p === path) navigate({ path: next[next.length - 1] ?? null })
      return next
    })
  }

  function switchBranch(name: string): void {
    if (name === branchName) return
    if (Object.values(edits).some(isDirty) && !window.confirm('You have unsaved edits on this branch. Switch anyway? (Saved drafts are kept.)')) return
    setEdits({})
    setTabs([])
    setExpanded(new Set())
    navigate({ branch: name, path: null })
  }

  function toggleDir(dir: string): void {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }

  function startEdit(): void {
    if (!path || !f || f.content === null) return
    setEdits((m) => ({ ...m, [path]: { mode: 'edit', buffer: f.content ?? '', saved: f.content ?? '', baseBlobSha: f.blobSha } }))
  }

  async function run(action: () => Promise<void>, failure: string): Promise<void> {
    setBusy(true)
    try {
      await action()
    } catch (err) {
      toast.error(err instanceof AppError ? err.message : failure)
    } finally {
      setBusy(false)
    }
  }

  /** Save one file's edit as a draft (optionally re-based on the branch's current version). */
  async function persist(p: string, state: EditState, rebaseTo?: string): Promise<void> {
    const draft = await saveDraft(project.key, { branch: branchName, path: p, content: state.buffer, baseBlobSha: rebaseTo ?? state.baseBlobSha })
    setEdits((m) => ({ ...m, [p]: { ...state, saved: state.buffer, baseBlobSha: draft.baseBlobSha } }))
  }

  const save = (): Promise<void> =>
    run(async () => {
      if (!path || !edit || !isDirty(edit)) return
      await persist(path, edit)
      await Promise.all([file.reload(), drafts.reload(), tree.refresh()])
      toast.success('Draft saved', { description: 'Only you can see it until you commit.' })
    }, 'Could not save the draft.')

  const rebase = (): Promise<void> =>
    run(async () => {
      if (!path || !edit || !f) return
      await persist(path, edit, f.blobSha)
      await Promise.all([file.reload(), drafts.reload()])
    }, 'Could not update the draft.')

  const discard = (): Promise<void> =>
    run(async () => {
      if (!path) return
      if (f?.draft) await discardDraft(project.key, branchName, path)
      setEdits(({ [path]: _discarded, ...rest }) => rest)
      await Promise.all([file.reload(), drafts.reload(), tree.refresh()])
    }, 'Could not discard the edit.')

  /** Save every unsaved edit, then open the commit dialog with all of your drafts on this branch. */
  const startCommit = (): Promise<void> =>
    run(async () => {
      for (const [p, state] of Object.entries(edits)) if (isDirty(state)) await persist(p, state)
      await Promise.all([drafts.reload(), file.reload(), tree.refresh()])
      setCommitOpen(true)
    }, 'Could not save your edits before committing.')

  function committed(paths: string[]): void {
    setEdits((m) => Object.fromEntries(Object.entries(m).filter(([p]) => !paths.includes(p))))
    void Promise.all([file.reload(), drafts.reload(), tree.refresh()])
  }

  /** Workspaces: add a file (committed at once) and open it for editing. */
  async function addFile(p: string): Promise<void> {
    await createRepoFile(project.key, { branch: branchName, path: p })
    await tree.refresh()
    openFile(p)
    toast.success(`Created ${p}`)
  }

  /** Workspaces: delete a file (committed at once). */
  function removeFile(p: string): void {
    if (!window.confirm(`Delete ${p}? This is committed to the workspace straight away.`)) return
    void run(async () => {
      await deleteRepoFile(project.key, branchName, p)
      setEdits(({ [p]: _deleted, ...rest }) => rest)
      setTabs((t) => {
        const next = t.filter((x) => x !== p)
        if (p === path) navigate({ path: next[next.length - 1] ?? null })
        return next
      })
      await Promise.all([tree.refresh(), drafts.reload()])
      toast.success(`Deleted ${p}`)
    }, 'Could not delete the file.')
  }

  async function newBranch(name: string, from: string): Promise<void> {
    await createBranch(project.key, { name, from })
    toast.success(`Created ${name} from ${from}`)
    switchBranch(name)
  }

  return (
    <div className="flex h-[calc(100svh-12.5rem)] min-h-[520px] flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <BranchSwitcher
          branches={branches}
          current={branchName}
          canCreate={canEdit && !workspace}
          onSelect={switchBranch}
          onCreate={newBranch}
          runBranches={runBranches.data ?? []}
          onSelectRun={(runId) => router.replace(`${pathname}?run=${encodeURIComponent(runId)}`, { scroll: false })}
        />
        {branch?.commit ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={`${branch.commit.sha}\n${branch.commit.message}`}>
            <GitCommitHorizontal className="size-3.5 shrink-0" />
            <span className="font-mono">{branch.commit.sha.slice(0, 7)}</span>
            <span className="hidden max-w-80 truncate md:inline">{branch.commit.message}</span>
            {branch.commit.author ? <span className="hidden lg:inline">· {branch.commit.author}</span> : null}
            {branch.commit.committedAt ? <span className="hidden lg:inline">· {relativeTime(branch.commit.committedAt)}</span> : null}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {canEdit && (drafts.data?.length ?? 0) > 0 ? (
            <button type="button" className="text-xs text-warning hover:underline" onClick={() => void startCommit()}>
              {drafts.data!.length} uncommitted {drafts.data!.length === 1 ? 'edit' : 'edits'}
            </button>
          ) : null}
          {ready ? <QuickOpen projectKey={project.key} branch={branchName} onOpen={openFile} /> : null}
        </div>
      </div>

      {!ready ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          {branch ? <Spinner className="size-6" /> : <Loader className="size-6" />}
          {branch ? (
            <p>
              Loading <span className="font-mono">{branchName}</span> — fetching its files (respecting .gitignore)…
            </p>
          ) : (
            <p>This branch no longer exists on the remote.</p>
          )}
        </div>
      ) : (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="24%" minSize="12%" maxSize="50%" className="flex min-w-0 flex-col bg-muted/20">
            <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Explorer
              <span className="flex items-center gap-1 font-normal normal-case">
                {branch?.fileCount ?? 0} files{branch?.ignoredCount ? ` · ${branch.ignoredCount} ignored` : ''}
                {workspace && canEdit ? (
                  <button
                    type="button"
                    onClick={() => setNewFileOpen(true)}
                    className="ml-1 flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    title="New file"
                    aria-label="New file"
                  >
                    <FilePlus className="size-4" />
                  </button>
                ) : null}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <FileExplorer
                tree={tree}
                expanded={expanded}
                onToggle={toggleDir}
                activePath={path}
                onOpen={openFile}
                onDelete={workspace && canEdit ? removeFile : undefined}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="76%" minSize="40%" className="min-w-0">
            <EditorArea
              branch={branchName}
              path={path}
              tabs={tabs.includes(path ?? '') || !path ? tabs : [...tabs, path]}
              onSelectTab={(p) => navigate({ path: p })}
              onCloseTab={closeTab}
              file={file}
              edit={edit}
              edits={edits}
              canEdit={canEdit}
              busy={busy}
              onStartEdit={startEdit}
              onChangeBuffer={(v) => path && setEdits((m) => (m[path] ? { ...m, [path]: { ...m[path], buffer: v } } : m))}
              onSave={() => void save()}
              onRebase={() => void rebase()}
              onDiscard={() => void discard()}
              onToggleDiff={() => path && setEdits((m) => (m[path] ? { ...m, [path]: { ...m[path], mode: m[path].mode === 'diff' ? 'edit' : 'diff' } } : m))}
              onCommit={() => void startCommit()}
              line={line}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      {workspace ? (
        <NewFileDialog open={newFileOpen} onOpenChange={setNewFileOpen} folder={path ? parentDirs(path).pop() ?? '' : ''} onCreate={addFile} />
      ) : null}
      <CommitDialog
        open={commitOpen}
        onOpenChange={setCommitOpen}
        projectKey={project.key}
        branch={branchName}
        drafts={drafts.data ?? []}
        initialPath={path}
        onCommitted={committed}
        onReview={openFile}
      />
    </div>
  )
}
