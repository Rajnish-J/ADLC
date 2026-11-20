'use client'

// The Review form, generated from the shared DRAFT_FORMS descriptors (the VS Code panel renders the same ones):
// text, long text, markdown, dates, switches, selects (fixed options or the project's agents / skills / Git
// connections), tags, string lists and lists of objects (workflow steps, stories and their tasks).

import { useState } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Plus, Trash2, X } from 'lucide-react'
import type { DraftFormField, DraftOptionSource } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { Markdown } from '@/components/common/markdown'

export type Option = { value: string; label: string }
export type OptionSets = Record<DraftOptionSource, Option[]>
type Obj = Record<string, unknown>

const NONE = '__none__'

function visible(field: DraftFormField, value: Obj): boolean {
  return !field.showWhen || field.showWhen.equals.includes(String(value[field.showWhen.key] ?? ''))
}

function TagsInput({ value, onChange, placeholder, disabled }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean }) {
  const [text, setText] = useState('')
  const add = () => {
    const parts = text.split(',').map((t) => t.trim()).filter(Boolean)
    if (parts.length) onChange([...new Set([...value, ...parts])])
    setText('')
  }
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border bg-background px-2 py-1">
      {value.map((t) => (
        <UI.Badge key={t} variant="secondary" className="gap-1 font-mono text-[11px]">
          {t}
          <button type="button" disabled={disabled} onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
            <X className="size-3" />
          </button>
        </UI.Badge>
      ))}
      <input
        value={text}
        disabled={disabled}
        placeholder={value.length ? '' : (placeholder ?? 'Type and press Enter')}
        onChange={(e) => setText(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
        }}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none"
      />
    </div>
  )
}

function StringList({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((item, i) => (
        <div key={i} className="flex gap-1.5">
          <UI.Input value={item} disabled={disabled} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} className="h-8 text-sm" />
          <UI.Button type="button" variant="ghost" size="icon-sm" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove">
            <X className="size-3.5" />
          </UI.Button>
        </div>
      ))}
      <UI.Button type="button" variant="outline" size="xs" className="self-start" disabled={disabled} onClick={() => onChange([...value, ''])}>
        <Plus className="size-3" />
        Add
      </UI.Button>
    </div>
  )
}

function MultiSelect({ value, options, onChange, disabled }: { value: string[]; options: Option[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const label = value.length ? value.map((v) => options.find((o) => o.value === v)?.label ?? v).join(', ') : 'None'
  return (
    <UI.Popover>
      <UI.PopoverTrigger asChild disabled={disabled}>
        <UI.Button type="button" variant="outline" size="sm" className="h-9 w-full justify-between font-normal">
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </UI.Button>
      </UI.PopoverTrigger>
      <UI.PopoverContent className="w-72 p-0" align="start">
        <UI.Command>
          <UI.CommandInput placeholder="Search…" />
          <UI.CommandList>
            <UI.CommandEmpty>Nothing found.</UI.CommandEmpty>
            <UI.CommandGroup>
              {options.map((o) => {
                const on = value.includes(o.value)
                return (
                  <UI.CommandItem key={o.value} value={`${o.label} ${o.value}`} onSelect={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}>
                    <Check className={UI.cn('size-3.5', on ? 'opacity-100' : 'opacity-0')} />
                    {o.label}
                  </UI.CommandItem>
                )
              })}
            </UI.CommandGroup>
          </UI.CommandList>
        </UI.Command>
      </UI.PopoverContent>
    </UI.Popover>
  )
}

function ObjectList({ field, value, onChange, options, disabled }: { field: Extract<DraftFormField, { type: 'objectList' }>; value: Obj[]; onChange: (v: Obj[]) => void; options: OptionSets; disabled?: boolean }) {
  const [open, setOpen] = useState<number | null>(value.length === 1 ? 0 : null)
  const move = (i: number, d: -1 | 1) => {
    const next = [...value]
    const [item] = next.splice(i, 1)
    next.splice(i + d, 0, item)
    onChange(next)
    setOpen(i + d)
  }
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((item, i) => (
        <div key={i} className="rounded-lg border bg-muted/20">
          <div className="flex items-center gap-1 px-2 py-1.5">
            <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm" onClick={() => setOpen(open === i ? null : i)}>
              <ChevronRight className={UI.cn('size-3.5 shrink-0 transition-transform', open === i && 'rotate-90')} />
              <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
              <span className="truncate font-medium">{String(item[field.titleKey] || `Untitled ${field.itemLabel}`)}</span>
              {'kind' in item ? <UI.Badge variant="outline" className="ml-1 text-[10px]">{String(item.kind)}</UI.Badge> : null}
            </button>
            <UI.Button type="button" variant="ghost" size="icon-xs" disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label="Move up">
              <ArrowUp className="size-3" />
            </UI.Button>
            <UI.Button type="button" variant="ghost" size="icon-xs" disabled={disabled || i === value.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
              <ArrowDown className="size-3" />
            </UI.Button>
            <UI.Button type="button" variant="ghost" size="icon-xs" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${field.itemLabel}`}>
              <Trash2 className="size-3" />
            </UI.Button>
          </div>
          {open === i ? (
            <div className="border-t px-3 py-3">
              <FieldsEditor fields={field.fields} value={item} onChange={(v) => onChange(value.map((x, j) => (j === i ? v : x)))} options={options} disabled={disabled} />
            </div>
          ) : null}
        </div>
      ))}
      <UI.Button
        type="button"
        variant="outline"
        size="xs"
        className="self-start"
        disabled={disabled}
        onClick={() => {
          onChange([...value, structuredClone(field.newItem)])
          setOpen(value.length)
        }}
      >
        <Plus className="size-3" />
        Add {field.itemLabel}
      </UI.Button>
    </div>
  )
}

function FieldControl({ field, value, onChange, options, disabled }: { field: DraftFormField; value: unknown; onChange: (v: unknown) => void; options: OptionSets; disabled?: boolean }) {
  const text = typeof value === 'string' ? value : ''
  // An empty text box keeps a null value null (optional fields).
  const setText = (v: string) => onChange(v === '' && (value === null || value === undefined) ? null : v)
  switch (field.type) {
    case 'text':
      return <UI.Input value={text} placeholder={field.placeholder} disabled={disabled} onChange={(e) => setText(e.target.value)} className="h-9 text-sm" />
    case 'textarea':
      return <UI.Textarea value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} rows={3} className="text-sm" />
    case 'markdown':
      return (
        <UI.Tabs defaultValue="edit">
          <UI.TabsList className="h-8">
            <UI.TabsTrigger value="edit" className="text-xs">Edit</UI.TabsTrigger>
            <UI.TabsTrigger value="preview" className="text-xs">Preview</UI.TabsTrigger>
          </UI.TabsList>
          <UI.TabsContent value="edit">
            <UI.Textarea value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} rows={14} className="font-mono text-xs" />
          </UI.TabsContent>
          <UI.TabsContent value="preview">
            <div className="max-h-96 overflow-auto rounded-md border p-3">
              <Markdown source={text || '_Nothing yet._'} className="text-sm" />
            </div>
          </UI.TabsContent>
        </UI.Tabs>
      )
    case 'date':
      return <UI.Input type="date" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} className="h-9 w-44 text-sm" />
    case 'switch':
      return <UI.Switch checked={value === true} disabled={disabled} onCheckedChange={onChange} />
    case 'select': {
      const opts = field.options ?? (field.source ? options[field.source] : [])
      const current = typeof value === 'string' ? value : NONE
      const known = current === NONE || opts.some((o) => o.value === current)
      return (
        <UI.Select value={current} disabled={disabled} onValueChange={(v) => onChange(v === NONE ? null : v)}>
          <UI.SelectTrigger className="h-9 w-full text-sm">
            <UI.SelectValue />
          </UI.SelectTrigger>
          <UI.SelectContent>
            {field.nullable ? <UI.SelectItem value={NONE}>— None —</UI.SelectItem> : null}
            {!known ? <UI.SelectItem value={current}>{current} (not available)</UI.SelectItem> : null}
            {opts.map((o) => (
              <UI.SelectItem key={o.value} value={o.value}>
                {o.label}
              </UI.SelectItem>
            ))}
          </UI.SelectContent>
        </UI.Select>
      )
    }
    case 'multiselect':
      return <MultiSelect value={Array.isArray(value) ? (value as string[]) : []} options={options[field.source]} onChange={onChange} disabled={disabled} />
    case 'tags':
      return <TagsInput value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} placeholder={field.placeholder} disabled={disabled} />
    case 'list':
      return <StringList value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} disabled={disabled} />
    case 'objectList':
      return <ObjectList field={field} value={Array.isArray(value) ? (value as Obj[]) : []} onChange={onChange} options={options} disabled={disabled} />
  }
}

export function FieldsEditor({ fields, value, onChange, options, disabled }: { fields: DraftFormField[]; value: Obj; onChange: (v: Obj) => void; options: OptionSets; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {fields
        .filter((f) => visible(f, value))
        .map((f) => (
          <div key={f.key} className={UI.cn('flex flex-col gap-1.5', f.type === 'switch' && 'flex-row items-center justify-between')}>
            <UI.Label className="text-xs font-medium">{f.label}</UI.Label>
            <FieldControl field={f} value={value[f.key]} onChange={(v) => onChange({ ...value, [f.key]: v })} options={options} disabled={disabled} />
            {f.help ? <p className="text-xs text-muted-foreground">{f.help}</p> : null}
          </div>
        ))}
    </div>
  )
}
