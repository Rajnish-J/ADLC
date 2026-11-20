'use client'

// A unified diff: one collapsible block per file, added/removed lines tinted with the theme's success/destructive
// tokens. No diff library — the patch is plain `git diff` output.

import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import * as UI from '@/imports/UI.imports'

interface FileDiff {
  path: string
  lines: string[]
  additions: number
  deletions: number
}

function parse(patch: string): FileDiff[] {
  const files: FileDiff[] = []
  let current: FileDiff | undefined
  for (const line of patch.split('\n')) {
    const header = /^diff --git "?a\/.+?"? "?b\/(.+?)"?$/.exec(line)
    if (header) {
      current = { path: header[1], lines: [], additions: 0, deletions: 0 }
      files.push(current)
      continue
    }
    if (!current || /^(index |similarity |rename |new file mode|deleted file mode|old mode|new mode|--- |\+\+\+ )/.test(line)) continue
    if (line.startsWith('+')) current.additions++
    else if (line.startsWith('-')) current.deletions++
    current.lines.push(line)
  }
  return files
}

const lineClass = (line: string): string =>
  line.startsWith('@@')
    ? 'bg-muted text-muted-foreground'
    : line.startsWith('+')
      ? 'bg-success/12 text-foreground'
      : line.startsWith('-')
        ? 'bg-destructive/12 text-foreground'
        : 'text-foreground/80'

export default function DiffView({ patch, truncated }: { patch: string; truncated?: boolean }) {
  const files = useMemo(() => parse(patch), [patch])
  const [closed, setClosed] = useState<Set<string>>(new Set())
  if (files.length === 0) return <p className="text-sm text-muted-foreground">No textual changes.</p>
  return (
    <div className="flex flex-col gap-3">
      {files.map((f) => {
        const open = !closed.has(f.path)
        return (
          <div key={f.path} className="overflow-hidden rounded-lg border">
            <button
              type="button"
              className="flex w-full items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-left text-xs"
              onClick={() =>
                setClosed((prev) => {
                  const next = new Set(prev)
                  if (next.has(f.path)) next.delete(f.path)
                  else next.add(f.path)
                  return next
                })
              }
            >
              <ChevronRight className={UI.cn('size-3.5 transition-transform', open && 'rotate-90')} />
              <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
              <span className="font-mono text-success">+{f.additions}</span>
              <span className="font-mono text-destructive">−{f.deletions}</span>
            </button>
            {open ? (
              <pre className="max-h-[480px] overflow-auto font-mono text-xs leading-5">
                {f.lines.map((l, i) => (
                  <div key={i} className={UI.cn('px-3 whitespace-pre', lineClass(l))}>
                    {l || ' '}
                  </div>
                ))}
              </pre>
            ) : null}
          </div>
        )
      })}
      {truncated ? <p className="text-xs text-muted-foreground">The diff was too large and has been cut short.</p> : null}
    </div>
  )
}
