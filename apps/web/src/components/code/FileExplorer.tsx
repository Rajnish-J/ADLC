'use client'

// VS Code-style explorer: folders load when expanded, files the platform doesn't store (binary, too large,
// secret, …) are listed with an icon that says why, and files you have an unsaved-to-git edit of carry an "M".
// On a workflow run's branch, entries carry VS Code's SCM decorations: M / A / D / R on files (tinted, deletions struck
// through) and, on folders, how many changed files are inside. In a workspace, files can also be deleted from here.

import type { ReactNode } from 'react'
import { ChevronRight, FileCode2, FileImage, FileLock2, FileText, FileWarning, Folder, FolderGit2, FolderOpen, Link2, Trash2 } from 'lucide-react'
import { REPO_FILE_STATUS_LABELS, type TreeChange, type TreeEntry } from '@sdlc/contracts'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import type { CodeTree } from '@/hooks/code/useCodeTree'
import { cn } from '@/lib/utils'

const TEXT_DOC = /\.(md|mdx|txt|rst|adoc)$/i

function fileIcon(entry: TreeEntry): ReactNode {
  switch (entry.status) {
    case 'binary':
      return <FileImage />
    case 'too_large':
    case 'non_utf8':
      return <FileWarning />
    case 'secret':
      return <FileLock2 />
    case 'submodule':
      return <FolderGit2 />
    case 'symlink':
      return <Link2 />
    default:
      return TEXT_DOC.test(entry.name) ? <FileText /> : <FileCode2 />
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** VS Code's SCM colours and letters. */
const CHANGE: Record<TreeChange, { letter: string; label: string; text: string }> = {
  modified: { letter: 'M', label: 'Modified', text: 'text-amber-600 dark:text-amber-400' },
  added: { letter: 'A', label: 'Added', text: 'text-emerald-600 dark:text-emerald-400' },
  deleted: { letter: 'D', label: 'Deleted', text: 'text-red-600 dark:text-red-400' },
  renamed: { letter: 'R', label: 'Renamed', text: 'text-teal-600 dark:text-teal-400' },
}

interface Props {
  tree: Pick<CodeTree, 'folders' | 'loading' | 'error'>
  expanded: Set<string>
  onToggle: (dir: string) => void
  activePath: string | null
  onOpen: (path: string) => void
  /** Offered on files when set (workspaces). */
  onDelete?: (path: string) => void
  /** Show only changed entries (a run's branch). */
  onlyChanged?: boolean
}

function Rows({ dir, depth, ...props }: Props & { dir: string; depth: number }) {
  const { tree, expanded, onToggle, activePath, onOpen, onDelete, onlyChanged } = props
  const all = tree.folders.get(dir)
  const entries = all && onlyChanged ? all.filter((e) => e.change) : all
  if (!entries) {
    return tree.loading.has(dir) ? (
      <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground" style={{ paddingLeft: depth * 12 + 24 }}>
        <Spinner className="size-3" /> Loading…
      </div>
    ) : null
  }
  if (entries.length === 0 && dir === '') {
    return <p className="px-4 py-3 text-sm text-muted-foreground">{onlyChanged ? 'No changed files.' : 'No files on this branch.'}</p>
  }
  return (
    <>
      {entries.map((entry) => {
        const isDir = entry.type === 'dir'
        const open = isDir && expanded.has(entry.path)
        const active = entry.path === activePath
        const change = entry.change ? CHANGE[entry.change] : null
        return (
          <div key={entry.path} className="group/row relative">
            <button
              type="button"
              onClick={() => (isDir ? onToggle(entry.path) : onOpen(entry.path))}
              className={cn(
                'group flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[13px] outline-none hover:bg-muted/70 focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring',
                active && 'bg-accent text-accent-foreground hover:bg-accent',
                !isDir && entry.status !== 'stored' && 'text-muted-foreground',
              )}
              style={{ paddingLeft: depth * 12 + 8 }}
              title={isDir ? entry.path : `${entry.path}${entry.status && entry.status !== 'stored' ? ` — ${REPO_FILE_STATUS_LABELS[entry.status]}` : ''} · ${formatSize(entry.size)}`}
              aria-expanded={isDir ? open : undefined}
            >
              {isDir ? (
                <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              <span className="flex shrink-0 text-muted-foreground [&>svg]:size-4" aria-hidden>
                {isDir ? open ? <FolderOpen /> : <Folder /> : fileIcon(entry)}
              </span>
              <span
                className={cn('min-w-0 flex-1 truncate', entry.hasDraft && 'text-warning', change?.text, entry.change === 'deleted' && !isDir && 'line-through')}
              >
                {entry.name}
              </span>
              {change ? (
                <span
                  className={cn('shrink-0 font-mono text-[11px] font-semibold', change.text)}
                  title={isDir ? `${entry.changeCount ?? 0} changed file${entry.changeCount === 1 ? '' : 's'} inside` : change.label}
                >
                  {isDir ? `${entry.changeCount ?? 0} •` : change.letter}
                </span>
              ) : null}
              {entry.hasDraft ? (
                <span className="shrink-0 font-mono text-[11px] font-semibold text-warning" title={isDir ? 'Contains files you edited' : 'You have an uncommitted edit'}>
                  {isDir ? '•' : 'M'}
                </span>
              ) : null}
              {!isDir && onDelete ? <span className="w-5 shrink-0" aria-hidden /> : null}
            </button>
            {!isDir && onDelete ? (
              <button
                type="button"
                onClick={() => onDelete(entry.path)}
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                title={`Delete ${entry.name}`}
                aria-label={`Delete ${entry.path}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            ) : null}
            {open ? <Rows {...props} dir={entry.path} depth={depth + 1} /> : null}
          </div>
        )
      })}
    </>
  )
}

export default function FileExplorer(props: Props) {
  const { tree } = props
  if (tree.error && !tree.folders.has('')) {
    return <p className="px-4 py-3 text-sm text-destructive">{tree.error.message}</p>
  }
  if (!tree.folders.has('') && tree.loading.has('')) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-5" style={{ width: `${55 + ((i * 37) % 40)}%` }} />
        ))}
      </div>
    )
  }
  return (
    <ScrollArea className="h-full">
      <div className="py-1" role="tree">
        <Rows {...props} dir="" depth={0} />
      </div>
    </ScrollArea>
  )
}
