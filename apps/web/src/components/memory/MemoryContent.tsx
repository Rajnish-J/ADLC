'use client'

// Memory text: plain paragraphs, with ``` fenced code (e.g. a snippet added from the editor) shown as code.
// Long items are clamped until expanded.

import { useState } from 'react'
import * as UI from '@/imports/UI.imports'

type Segment = { code: false; text: string } | { code: true; text: string; lang: string }

function segments(text: string): Segment[] {
  const out: Segment[] = []
  const re = /```([\w-]*)\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) })
    out.push({ code: true, lang: m[1], text: m[2].replace(/\n$/, '') })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) })
  return out.filter((s) => s.text.trim())
}

export default function MemoryContent({ text, clampAt = 320 }: { text: string; clampAt?: number }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  const long = text.length > clampAt
  return (
    <div className="flex flex-col gap-1">
      <div className={UI.cn('flex flex-col gap-2 text-sm text-muted-foreground', long && !open && 'max-h-24 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]')}>
        {segments(text).map((s, i) =>
          s.code ? (
            <pre key={i} className="overflow-x-auto rounded-md border bg-muted/60 px-3 py-2 font-mono text-xs text-foreground">
              {s.text}
            </pre>
          ) : (
            <p key={i} className="leading-relaxed whitespace-pre-wrap">
              {s.text.trim()}
            </p>
          ),
        )}
      </div>
      {long ? (
        <button type="button" className="self-start text-xs font-medium text-primary hover:underline" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  )
}
