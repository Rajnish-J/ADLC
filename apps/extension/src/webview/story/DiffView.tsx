// A unified diff, one collapsible block per file, with added/removed lines tinted by the theme's diff colours.

import { useMemo, useState } from 'react'
import { cx } from './api'

interface FileDiff {
  path: string
  lines: string[]
}

function parse(patch: string): FileDiff[] {
  const files: FileDiff[] = []
  let current: FileDiff | undefined
  for (const line of patch.split('\n')) {
    const header = /^diff --git "?a\/.+?"? "?b\/(.+?)"?$/.exec(line)
    if (header) {
      current = { path: header[1], lines: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    if (/^(index |similarity |rename |new file mode|deleted file mode|old mode|new mode)/.test(line)) continue
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
    current.lines.push(line)
  }
  return files
}

function lineClass(line: string): string | undefined {
  if (line.startsWith('@@')) return 'diff-hunk'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  if (line.startsWith('\\')) return 'diff-meta'
  return undefined
}

export function DiffView({ patch, truncated }: { patch: string; truncated?: boolean }) {
  const files = useMemo(() => parse(patch), [patch])
  const [closed, setClosed] = useState<Set<string>>(new Set())
  if (files.length === 0) return <p className="muted">No textual changes.</p>
  return (
    <div className="diff">
      {files.map((f) => {
        const open = !closed.has(f.path)
        const adds = f.lines.filter((l) => l.startsWith('+')).length
        const dels = f.lines.filter((l) => l.startsWith('-')).length
        return (
          <div key={f.path} className="diff-file">
            <button
              type="button"
              className="diff-file-header"
              onClick={() =>
                setClosed((prev) => {
                  const next = new Set(prev)
                  if (next.has(f.path)) next.delete(f.path)
                  else next.add(f.path)
                  return next
                })
              }
            >
              <span className={cx('codicon-chevron', open && 'open')}>›</span>
              <span className="mono path">{f.path}</span>
              <span className="add">+{adds}</span>
              <span className="del">−{dels}</span>
            </button>
            {open ? (
              <pre className="diff-body">
                {f.lines.map((l, i) => (
                  <div key={i} className={lineClass(l)}>
                    {l || ' '}
                  </div>
                ))}
              </pre>
            ) : null}
          </div>
        )
      })}
      {truncated ? <p className="muted">The diff was too large and has been cut short.</p> : null}
    </div>
  )
}
