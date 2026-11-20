// Review & submit in the VS Code panel: the assistant's draft as a form generated from the same DRAFT_FORMS the
// web app uses (native controls, theme colours), then Save / Submit / Discard through the host.

import { useEffect, useState } from 'react'
import { DRAFT_FORMS, DRAFT_KIND_LABELS, type ChatDraft, type DraftFormField, type DraftOptionSource } from '@sdlc/contracts'
import { api, ApiError } from './bridge'

type Obj = Record<string, unknown>
export type Options = Record<DraftOptionSource, { value: string; label: string }[]>

const visible = (f: DraftFormField, v: Obj) => !f.showWhen || f.showWhen.equals.includes(String(v[f.showWhen.key] ?? ''))
const NONE = '__none__'

function Field({ field, value, onChange, options, disabled }: { field: DraftFormField; value: unknown; onChange: (v: unknown) => void; options: Options; disabled: boolean }) {
  const text = typeof value === 'string' ? value : ''
  const keepNull = (v: string) => onChange(v === '' && (value === null || value === undefined) ? null : v)
  switch (field.type) {
    case 'text':
      return <input className="input" value={text} placeholder={field.placeholder} disabled={disabled} onChange={(e) => keepNull(e.target.value)} />
    case 'textarea':
      return <textarea className="input" rows={3} value={text} disabled={disabled} onChange={(e) => keepNull(e.target.value)} />
    case 'markdown':
      return <textarea className="input mono" rows={12} value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    case 'date':
      return <input className="input narrow" type="date" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} />
    case 'switch':
      return <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    case 'select': {
      const opts = field.options ?? (field.source ? options[field.source] : [])
      const current = typeof value === 'string' ? value : NONE
      return (
        <select className="input" value={current} disabled={disabled} onChange={(e) => onChange(e.target.value === NONE ? null : e.target.value)}>
          {field.nullable || current === NONE ? <option value={NONE}>— None —</option> : null}
          {current !== NONE && !opts.some((o) => o.value === current) ? <option value={current}>{current} (not available)</option> : null}
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    }
    case 'multiselect': {
      const list = Array.isArray(value) ? (value as string[]) : []
      return (
        <div className="checks">
          {options[field.source].map((o) => (
            <label key={o.value}>
              <input type="checkbox" checked={list.includes(o.value)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...list, o.value] : list.filter((x) => x !== o.value))} />
              {o.label}
            </label>
          ))}
          {options[field.source].length === 0 ? <span className="muted small">None available</span> : null}
        </div>
      )
    }
    case 'tags': {
      const list = Array.isArray(value) ? (value as string[]) : []
      return (
        <input
          className="input"
          placeholder="Comma-separated"
          defaultValue={list.join(', ')}
          disabled={disabled}
          onBlur={(e) => onChange([...new Set(e.target.value.split(',').map((t) => t.trim()).filter(Boolean))])}
        />
      )
    }
    case 'list': {
      const list = Array.isArray(value) ? (value as string[]) : []
      return (
        <textarea
          className="input"
          rows={Math.max(3, list.length + 1)}
          placeholder="One per line"
          defaultValue={list.join('\n')}
          disabled={disabled}
          onBlur={(e) => onChange(e.target.value.split('\n').map((t) => t.trim()).filter(Boolean))}
        />
      )
    }
    case 'objectList': {
      const items = Array.isArray(value) ? (value as Obj[]) : []
      const set = (next: Obj[]) => onChange(next)
      return (
        <div className="objects">
          {items.map((item, i) => (
            <details key={i} className="object">
              <summary>
                <span className="muted">{i + 1}.</span> {String(item[field.titleKey] || `Untitled ${field.itemLabel}`)}
                {'kind' in item ? <span className="badge">{String(item.kind)}</span> : null}
                <span className="push" />
                <button type="button" className="icon" disabled={disabled || i === 0} onClick={(e) => (e.preventDefault(), set(move(items, i, -1)))} title="Move up">
                  ↑
                </button>
                <button type="button" className="icon" disabled={disabled || i === items.length - 1} onClick={(e) => (e.preventDefault(), set(move(items, i, 1)))} title="Move down">
                  ↓
                </button>
                <button type="button" className="icon" disabled={disabled} onClick={(e) => (e.preventDefault(), set(items.filter((_, j) => j !== i)))} title={`Remove ${field.itemLabel}`}>
                  ✕
                </button>
              </summary>
              <Fields fields={field.fields} value={item} onChange={(v) => set(items.map((x, j) => (j === i ? v : x)))} options={options} disabled={disabled} />
            </details>
          ))}
          <button type="button" className="secondary small-btn" disabled={disabled} onClick={() => set([...items, structuredClone(field.newItem)])}>
            + Add {field.itemLabel}
          </button>
        </div>
      )
    }
  }
}

function move(items: Obj[], i: number, d: -1 | 1): Obj[] {
  const next = [...items]
  const [x] = next.splice(i, 1)
  next.splice(i + d, 0, x)
  return next
}

export function Fields({ fields, value, onChange, options, disabled }: { fields: DraftFormField[]; value: Obj; onChange: (v: Obj) => void; options: Options; disabled: boolean }) {
  return (
    <div className="fields">
      {fields
        .filter((f) => visible(f, value))
        .map((f) => (
          <label key={f.key} className={`field ${f.type === 'switch' ? 'inline' : ''}`}>
            <span className="field-label">{f.label}</span>
            <Field field={f} value={value[f.key]} onChange={(v) => onChange({ ...value, [f.key]: v })} options={options} disabled={disabled} />
            {f.help ? <span className="muted small">{f.help}</span> : null}
          </label>
        ))}
    </div>
  )
}

export default function DraftReview({ draft, options, onClose, onChanged }: { draft: ChatDraft; options: Options; onClose: () => void; onChanged: (d: ChatDraft) => void }) {
  const [data, setData] = useState<Obj>(() => structuredClone((draft.data ?? {}) as Obj))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Discarding can't be undone; webviews have no confirm(), so it takes a second click.
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  useEffect(() => {
    if (!dirty) setData(structuredClone((draft.data ?? {}) as Obj))
  }, [draft, dirty])

  const labels = DRAFT_KIND_LABELS[draft.kind]
  const open = draft.status === 'open'
  const submitLabel = draft.targetId ? 'Save changes' : draft.kind === 'stories' ? 'Create stories' : `Create ${labels.noun}`

  const run = async (what: 'save' | 'submit' | 'discard') => {
    setBusy(true)
    setError(null)
    try {
      let current = draft
      if (what !== 'discard' && dirty) {
        current = await api<ChatDraft>('PATCH', `/chat/drafts/${draft.id}`, { version: draft.version, data })
        setDirty(false)
        onChanged(current)
      }
      if (what === 'submit') {
        onChanged(await api<ChatDraft>('POST', `/chat/drafts/${current.id}/submit`))
        onClose()
      } else if (what === 'discard') {
        onChanged(await api<ChatDraft>('POST', `/chat/drafts/${draft.id}/discard`))
        onClose()
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <h2>{draft.targetLabel ? `Edit ${labels.noun}: ${draft.targetLabel}` : labels.title}</h2>
            <div className="muted small">{draft.projectKey ? `In ${draft.projectKey}. ` : ''}Check the draft, change anything, then submit.</div>
          </div>
          <button type="button" className="icon" onClick={onClose} title="Close">
            ✕
          </button>
        </header>
        <div className="drawer-body">
          {!open ? <div className="notice">{draft.result?.label ?? 'This draft is closed.'}</div> : null}
          {draft.openQuestions.length ? (
            <div className="notice">
              <strong>Still open</strong>
              <ul>
                {draft.openQuestions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <Fields
            fields={DRAFT_FORMS[draft.kind]}
            value={data}
            options={options}
            disabled={!open || busy}
            onChange={(v) => {
              setData(v)
              setDirty(true)
            }}
          />
        </div>
        {open ? (
          <footer className="drawer-foot">
            {error ? <div className="notice err">{error}</div> : null}
            <div className="actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => (confirmDiscard ? void run('discard') : setConfirmDiscard(true))}>
                {confirmDiscard ? 'Click again to discard' : 'Discard'}
              </button>
              <span className="push" />
              {dirty ? (
                <button type="button" className="secondary" disabled={busy} onClick={() => void run('save')}>
                  Save edits
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => void run('submit')}>
                {submitLabel}
              </button>
            </div>
          </footer>
        ) : null}
      </aside>
    </div>
  )
}
