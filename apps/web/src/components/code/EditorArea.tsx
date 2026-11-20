'use client'

// The editor side of the workbench: open-file tabs, the file's path and actions, and Monaco. Files open read-only;
// Edit turns that one file editable, Save keeps your edit as a private draft (Ctrl+S), Review shows your changes
// against the branch, and Commit pushes them. A draft whose file changed on the branch meanwhile is flagged.

import { useEffect } from 'react'
import Link from 'next/link'
import { AlertTriangle, ExternalLink, FileWarning, GitCommitHorizontal, GitCompareArrows, History, Pencil, Save, Undo2, X } from 'lucide-react'
import { REPO_FILE_STATUS_LABELS, type RepoFile } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { EmptyState, ErrorAlert } from '@/components/common/feedback'
import { useCurrentProject } from '@/components/layout/current-project'
import { cn } from '@/lib/utils'
import { CodeDiff, CodeEditor } from './Monaco'

/** An open file's edit session: what's in the editor, what was last saved as a draft, and the base it started from. */
export interface EditState {
  mode: 'edit' | 'diff'
  buffer: string
  saved: string
  baseBlobSha: string
}

export const isDirty = (e: EditState | undefined): boolean => e !== undefined && e.buffer !== e.saved

interface Props {
  branch: string
  path: string | null
  tabs: string[]
  onSelectTab: (path: string) => void
  onCloseTab: (path: string) => void
  file: { data: RepoFile | null; error: AppError | null; loading: boolean }
  edit: EditState | undefined
  edits: Record<string, EditState>
  canEdit: boolean
  busy: boolean
  onStartEdit: () => void
  onChangeBuffer: (value: string) => void
  onSave: () => void
  /** "Keep my version" for a draft whose file changed on the branch. */
  onRebase: () => void
  onDiscard: () => void
  onToggleDiff: () => void
  onCommit: () => void
  line?: number
}

function Tabs({ tabs, active, edits, onSelect, onClose }: { tabs: string[]; active: string | null; edits: Record<string, EditState>; onSelect: (p: string) => void; onClose: (p: string) => void }) {
  if (tabs.length === 0) return null
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-muted/30" role="tablist">
      {tabs.map((p) => {
        const name = p.split('/').pop() ?? p
        const dirty = isDirty(edits[p])
        return (
          <div
            key={p}
            role="tab"
            aria-selected={p === active}
            className={cn(
              'group flex max-w-56 shrink-0 items-center gap-1.5 border-r pr-1 pl-3 text-[13px]',
              p === active ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/60',
            )}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                onClose(p)
              }
            }}
          >
            <button type="button" className={cn('min-w-0 truncate py-1 text-left', edits[p] && 'italic')} onClick={() => onSelect(p)} title={p}>
              {name}
            </button>
            <button
              type="button"
              onClick={() => onClose(p)}
              className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-muted"
              aria-label={`Close ${name}`}
              title={dirty ? 'Unsaved changes' : 'Close'}
            >
              {dirty ? <span className="size-2 rounded-full bg-foreground group-hover:hidden" /> : null}
              <X className={cn('size-3.5', dirty && 'hidden group-hover:block')} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export default function EditorArea(props: Props) {
  const { branch, path, tabs, file, edit, edits, canEdit, busy } = props
  const f = file.data && file.data.path === path ? file.data : null
  const projectKey = useCurrentProject().key

  // Warn before leaving the page with unsaved edits.
  const anyDirty = Object.values(edits).some(isDirty)
  useEffect(() => {
    if (!anyDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [anyDirty])

  let body: React.ReactNode
  if (!path) {
    body = (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState icon={<Pencil />} title="No file open" description="Pick a file in the explorer, or press Ctrl+P to find one." />
      </div>
    )
  } else if (file.error && !f) {
    body = (
      <div className="p-4">
        <ErrorAlert title={file.error.status === 404 ? 'File not found on this branch' : 'Could not open the file'} message={file.error.message} />
      </div>
    )
  } else if (!f) {
    body = <Skeleton className="h-full w-full rounded-none" />
  } else if (f.status !== 'stored' || f.content === null) {
    body = (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState icon={<FileWarning />} title={REPO_FILE_STATUS_LABELS[f.status]} description={`${f.path} · ${f.size.toLocaleString()} bytes. The platform lists this file but doesn't keep its contents.`}>
          {f.webUrl ? (
            <Button variant="outline" size="sm" asChild>
              <a href={f.webUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink /> Open on the remote
              </a>
            </Button>
          ) : null}
        </EmptyState>
      </div>
    )
  } else if (edit?.mode === 'diff') {
    body = <CodeDiff path={`${branch}/${f.path}`} original={f.content} modified={edit.buffer} />
  } else {
    body = (
      <CodeEditor
        path={`${branch}/${f.path}`}
        value={edit ? edit.buffer : f.content}
        readOnly={!edit}
        onChange={edit ? props.onChangeBuffer : undefined}
        onSave={edit ? props.onSave : undefined}
        line={props.line}
      />
    )
  }

  const dirty = isDirty(edit)
  const stale = Boolean(f?.draft?.stale)
  const segments = path ? path.split('/') : []

  return (
    <div className="flex h-full min-w-0 flex-col">
      <Tabs tabs={tabs} active={path} edits={edits} onSelect={props.onSelectTab} onClose={props.onCloseTab} />
      {path ? (
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 font-mono text-xs text-muted-foreground" title={path}>
            {segments.map((s, i) => (
              <span key={`${s}-${i}`} className={cn('truncate', i === segments.length - 1 && 'text-foreground')}>
                {i > 0 ? <span className="mx-1 opacity-60">›</span> : null}
                {s}
              </span>
            ))}
            {edit ? (
              <Badge variant={dirty ? 'warning' : 'secondary'} className="ml-2 h-5 font-sans">
                {dirty ? 'Unsaved' : f?.draft ? 'Draft saved' : 'Editing'}
              </Badge>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {busy ? <Spinner className="text-muted-foreground" /> : null}
            {f?.webUrl ? (
              <Button variant="ghost" size="sm" asChild title="Open on the remote">
                <a href={f.webUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                </a>
              </Button>
            ) : null}
            {projectKey && path ? (
              <Button variant="ghost" size="sm" asChild title="Agent runs that changed this file">
                <Link href={`/projects/${encodeURIComponent(projectKey)}/workflow?tab=runs&file=${encodeURIComponent(path)}`}>
                  <History /> Runs
                </Link>
              </Button>
            ) : null}
            {!edit && f?.editable && canEdit ? (
              <Button size="sm" variant="outline" onClick={props.onStartEdit} disabled={busy}>
                <Pencil /> Edit
              </Button>
            ) : null}
            {edit ? (
              <>
                <Button size="sm" variant="ghost" onClick={props.onToggleDiff} disabled={busy} title="Compare your version with the branch">
                  <GitCompareArrows /> {edit.mode === 'diff' ? 'Back to editing' : 'Review changes'}
                </Button>
                <Button size="sm" variant="ghost" onClick={props.onDiscard} disabled={busy} title="Throw away your edit of this file">
                  <Undo2 /> Discard
                </Button>
                <Button size="sm" variant="outline" onClick={props.onSave} disabled={busy || !dirty} title="Save as a private draft (Ctrl+S)">
                  <Save /> Save draft
                </Button>
                <Button size="sm" onClick={props.onCommit} disabled={busy || (!dirty && !f?.draft) || stale}>
                  <GitCommitHorizontal /> Commit…
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {stale && f ? (
        <Alert className="m-2 shrink-0 border-warning/50">
          <AlertTriangle />
          <AlertTitle>{f.path.split('/').pop()} changed on {branch} since you started editing</AlertTitle>
          <AlertDescription>
            <p>Review what’s different, then keep your version (it will replace the newer one when you commit) or discard your edit.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {edit?.mode !== 'diff' ? (
                <Button size="sm" variant="outline" onClick={props.onToggleDiff} disabled={busy}>
                  <GitCompareArrows /> Compare with latest
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={props.onRebase} disabled={busy}>
                Keep my version
              </Button>
              <Button size="sm" variant="ghost" onClick={props.onDiscard} disabled={busy}>
                Discard my edit
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  )
}
