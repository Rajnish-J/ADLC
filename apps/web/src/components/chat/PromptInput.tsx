'use client'

// The composer: a growing text box with the assistant / tools / project controls on the left of the toolbar and
// voice, context usage, model and Send (or Stop) on the right. Enter sends; Shift+Enter adds a line.

import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import * as UI from '@/imports/UI.imports'

interface Props {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onStop: () => void
  /** A turn is running: Send becomes Stop. */
  busy: boolean
  disabled?: boolean
  placeholder: string
  left: ReactNode
  right: ReactNode
  className?: string
}

export default function PromptInput({ value, onChange, onSubmit, onStop, busy, disabled, placeholder, left, right, className }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [value])

  const canSend = !disabled && !busy && value.trim().length > 0

  return (
    <form
      className={UI.cn('flex flex-col gap-1 rounded-3xl border bg-muted/40 p-2 shadow-sm focus-within:border-ring/60 dark:bg-muted/20', className)}
      onSubmit={(e) => {
        e.preventDefault()
        if (canSend) onSubmit()
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Message"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (canSend) onSubmit()
          }
        }}
        className="max-h-60 min-h-11 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />
      <div className="flex flex-wrap items-center gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-0.5">{left}</div>
        <div className="ml-auto flex items-center gap-0.5">
          {right}
          {busy ? (
            <UI.Button type="button" size="icon" className="ml-1 size-9 rounded-full" onClick={onStop} aria-label="Stop">
              <Square className="size-3.5 fill-current" />
            </UI.Button>
          ) : (
            <UI.Button type="submit" size="icon" className="ml-1 size-9 rounded-full" disabled={!canSend} aria-label="Send">
              <ArrowUp className="size-4" />
            </UI.Button>
          )}
        </div>
      </div>
    </form>
  )
}
