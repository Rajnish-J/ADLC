'use client'

// Inputs for a story's labels and due date, used by the drawer's property rows. Both save on every change.

import { useId, useRef, useState } from 'react'
import { CalendarDays, X } from 'lucide-react'
import { MAX_LABEL_LENGTH, MAX_STORY_LABELS, normalizeLabel } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { dueState, formatDueDate } from '@/utils/format'

interface LabelsInputProps {
  labels: string[]
  /** Labels already used in the project, offered as you type. */
  suggestions: string[]
  /** True while a save is running — new entries wait so two saves never race. */
  saving: boolean
  onChange: (labels: string[]) => void
}

/** Label chips with an inline input: Enter (or comma) adds, × or Backspace on an empty input removes. */
export function LabelsInput({ labels, suggestions, saving, onChange }: LabelsInputProps) {
  const [draft, setDraft] = useState('')
  const listId = useId()
  const full = labels.length >= MAX_STORY_LABELS

  function add(raw: string): void {
    const label = normalizeLabel(raw).slice(0, MAX_LABEL_LENGTH)
    if (saving || !label) return
    setDraft('')
    if (!labels.includes(label) && !full) onChange([...labels, label])
  }

  return (
    <div className="flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 transition-[box-shadow,border-color] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
      {labels.map((l) => (
        <span key={l} className="inline-flex h-6 max-w-44 items-center gap-0.5 rounded-md bg-secondary pr-0.5 pl-2 text-xs text-secondary-foreground">
          <span className="truncate">{l}</span>
          <button
            type="button"
            aria-label={`Remove label ${l}`}
            disabled={saving}
            onClick={() => onChange(labels.filter((x) => x !== l))}
            className="rounded-sm p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {full ? (
        <span className="text-xs text-muted-foreground">{MAX_STORY_LABELS} labels max</span>
      ) : (
        <input
          list={listId}
          value={draft}
          maxLength={MAX_LABEL_LENGTH + 8}
          aria-label="Add a label"
          placeholder={labels.length > 0 ? 'Add label…' : 'Add a label… (Enter to add)'}
          className="h-6 min-w-28 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft.trim() && add(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add(draft)
            } else if (e.key === 'Backspace' && !draft && labels.length > 0 && !saving) {
              onChange(labels.slice(0, -1))
            }
          }}
        />
      )}
      <datalist id={listId}>
        {suggestions
          .filter((s) => !labels.includes(s))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  )
}

interface DueDatePickerProps {
  value: string | null
  done: boolean
  disabled: boolean
  onChange: (value: string | null) => void
}

/** "Set due date" / "Nov 3" button that opens the browser's date picker, plus a clear button. */
export function DueDatePicker({ value, done, disabled, onChange }: DueDatePickerProps) {
  const input = useRef<HTMLInputElement>(null)
  const overdue = value !== null && dueState(value, done) === 'overdue'

  function open(): void {
    const el = input.current
    if (!el) return
    try {
      el.showPicker()
    } catch {
      el.focus()
    }
  }

  return (
    <span className="relative inline-flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={open}
        className={cn(overdue && 'border-destructive/40 text-destructive')}
        aria-label={value ? `Due ${formatDueDate(value)}. Change the due date` : 'Set due date'}
      >
        <CalendarDays />
        {value ? formatDueDate(value) : 'Set due date'}
      </Button>
      <input
        ref={input}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="pointer-events-none absolute bottom-0 left-0 size-0 opacity-0 [color-scheme:light] dark:[color-scheme:dark]"
      />
      {value ? (
        <Button type="button" variant="ghost" size="icon-xs" disabled={disabled} onClick={() => onChange(null)} aria-label="Clear the due date">
          <X />
        </Button>
      ) : null}
      {overdue ? <span className="text-xs font-medium text-destructive">Overdue</span> : null}
    </span>
  )
}
