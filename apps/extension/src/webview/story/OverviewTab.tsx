// "Overview": the story itself — description, acceptance criteria, details — and what you can do with it here.
// Whoever may edit the story edits it in place, with the same rules as the web app: an assignee updates the
// description and labels, ticks criteria and flags a blocker; a lead or owner also changes the title, priority,
// due date and the criteria themselves, and assigns the story.

import { useEffect, useState } from 'react'
import type { AcceptanceCriterion, Story, StoryPriority } from '@sdlc/contracts'
import type { AssignableMember, StoryEdit } from '../../platform/storyPanel/storyPanelMessages'
import { cx, exactTime, onHostMessage, PRIORITIES, PRIORITY_LABEL, relativeTime, send, STATUS_LABEL } from './api'

/** May the user redefine the story (title, priority, due date, criteria)? The API applies the same rule. */
export function canRedefine(story: Story): boolean {
  return story.actions.canEdit && story.actions.canAssign
}

/** Edit-in-place state for one field: open/closed, and saving until the host answers with `saved`. */
function useEditor(field: string) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(
    () =>
      onHostMessage((msg) => {
        if (msg.type !== 'saved' || msg.field !== field) return
        setSaving(false)
        if (msg.ok) setEditing(false)
      }),
    [field],
  )
  const save = (edit: StoryEdit) => {
    setSaving(true)
    send({ type: 'update', field, edit })
  }
  return { editing, setEditing, saving, save }
}

export function EditableTitle({ story }: { story: Story }) {
  const ed = useEditor('title')
  const [value, setValue] = useState(story.title)
  useEffect(() => setValue(story.title), [story.title])
  if (!ed.editing) {
    return (
      <div className="row title-row">
        <h1 className="grow">{story.title}</h1>
        {canRedefine(story) ? (
          <button type="button" className="btn ghost small" onClick={() => ed.setEditing(true)}>
            Rename
          </button>
        ) : null}
      </div>
    )
  }
  return (
    <form
      className="row title-row"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim() && value.trim() !== story.title) ed.save({ title: value.trim() })
        else ed.setEditing(false)
      }}
    >
      <input className="grow title-input" value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} autoFocus disabled={ed.saving} />
      <button type="submit" className="btn small" disabled={ed.saving || !value.trim()}>
        Save
      </button>
      <button type="button" className="btn ghost small" onClick={() => ed.setEditing(false)} disabled={ed.saving}>
        Cancel
      </button>
    </form>
  )
}

function Description({ story }: { story: Story }) {
  const ed = useEditor('description')
  const [value, setValue] = useState(story.description)
  useEffect(() => setValue(story.description), [story.description])
  return (
    <section>
      <div className="row">
        <h3 className="grow">Story</h3>
        {story.actions.canEdit && !ed.editing ? (
          <button type="button" className="btn ghost small" onClick={() => ed.setEditing(true)}>
            Edit
          </button>
        ) : null}
      </div>
      {ed.editing ? (
        <div className="form">
          <textarea rows={8} value={value} maxLength={10_000} onChange={(e) => setValue(e.target.value)} autoFocus disabled={ed.saving} />
          <div className="row">
            <button type="button" className="btn" disabled={ed.saving || value === story.description} onClick={() => ed.save({ description: value })}>
              Save
            </button>
            <button type="button" className="btn ghost" onClick={() => (setValue(story.description), ed.setEditing(false))} disabled={ed.saving}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="description">{story.description || <span className="muted">No description.</span>}</p>
      )}
    </section>
  )
}

function Criteria({ story }: { story: Story }) {
  const tick = useEditor('criteria-met')
  const ed = useEditor('criteria')
  const [draft, setDraft] = useState<AcceptanceCriterion[]>(story.acceptanceCriteria)
  useEffect(() => setDraft(story.acceptanceCriteria), [story.acceptanceCriteria])
  const total = story.acceptanceCriteria.length
  const met = story.acceptanceCriteria.filter((c) => c.met).length

  const toggle = (id: string, value: boolean) =>
    tick.save({ acceptanceCriteria: story.acceptanceCriteria.map((c) => (c.id === id ? { ...c, met: value } : c)) })

  if (ed.editing) {
    const cleaned = draft.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text)
    return (
      <section>
        <h3>Acceptance criteria</h3>
        <div className="form">
          {draft.map((c, i) => (
            <div key={c.id || `new-${i}`} className="row">
              <input
                className="grow"
                value={c.text}
                maxLength={500}
                placeholder="Given … when … then …"
                onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, text: e.target.value } : d)))}
                disabled={ed.saving}
              />
              <button type="button" className="btn ghost small" title="Remove" onClick={() => setDraft(draft.filter((_, j) => j !== i))} disabled={ed.saving}>
                Remove
              </button>
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn secondary small" onClick={() => setDraft([...draft, { id: '', text: '', met: false }])} disabled={ed.saving || draft.length >= 30}>
              Add criterion
            </button>
          </div>
          <div className="row">
            <button type="button" className="btn" disabled={ed.saving} onClick={() => ed.save({ acceptanceCriteria: cleaned })}>
              Save criteria
            </button>
            <button type="button" className="btn ghost" onClick={() => (setDraft(story.acceptanceCriteria), ed.setEditing(false))} disabled={ed.saving}>
              Cancel
            </button>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section>
      <div className="row">
        <h3 className="grow">Acceptance criteria {total ? `(${met}/${total} met)` : ''}</h3>
        {canRedefine(story) ? (
          <button type="button" className="btn ghost small" onClick={() => ed.setEditing(true)}>
            Edit criteria
          </button>
        ) : null}
      </div>
      {total === 0 ? (
        <p className="muted">No acceptance criteria.</p>
      ) : (
        <ul className="criteria">
          {story.acceptanceCriteria.map((c) => (
            <li key={c.id} className={c.met ? 'met' : undefined}>
              {story.actions.canEdit ? (
                <label className="criterion">
                  <input type="checkbox" checked={c.met} disabled={tick.saving} onChange={(e) => toggle(c.id, e.target.checked)} />
                  <span>{c.text}</span>
                </label>
              ) : (
                <>
                  <span className="check">{c.met ? '☑' : '☐'}</span>
                  {c.text}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Labels({ story }: { story: Story }) {
  const ed = useEditor('labels')
  const [value, setValue] = useState(story.labels.join(', '))
  useEffect(() => setValue(story.labels.join(', ')), [story.labels])
  if (ed.editing) {
    return (
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          // The API normalises labels ("Needs Migration" → "needs-migration") and drops duplicates.
          ed.save({ labels: value.split(',').map((l) => l.trim()).filter(Boolean) })
        }}
      >
        <input className="grow" value={value} placeholder="api, needs-migration" onChange={(e) => setValue(e.target.value)} autoFocus disabled={ed.saving} />
        <button type="submit" className="btn small" disabled={ed.saving}>
          Save
        </button>
        <button type="button" className="btn ghost small" onClick={() => ed.setEditing(false)} disabled={ed.saving}>
          Cancel
        </button>
      </form>
    )
  }
  return (
    <span className="row">
      {story.labels.length ? story.labels.map((l) => <span key={l} className="tag">#{l}</span>) : <span className="muted">None</span>}
      {story.actions.canEdit ? (
        <button type="button" className="link" onClick={() => ed.setEditing(true)}>
          Edit
        </button>
      ) : null}
    </span>
  )
}

function DueDate({ story }: { story: Story }) {
  const ed = useEditor('dueDate')
  const today = new Date().toISOString().slice(0, 10)
  const overdue = Boolean(story.dueDate && story.status !== 'done' && story.dueDate < today)
  if (!canRedefine(story)) {
    return story.dueDate ? <span className={cx(overdue && 'error')}>{story.dueDate}{overdue ? ' (overdue)' : ''}</span> : <span className="muted">None</span>
  }
  return (
    <span className="row">
      <input type="date" value={story.dueDate ?? ''} disabled={ed.saving} onChange={(e) => ed.save({ dueDate: e.target.value || null })} />
      {story.dueDate ? (
        <button type="button" className="link" disabled={ed.saving} onClick={() => ed.save({ dueDate: null })}>
          Clear
        </button>
      ) : null}
      {overdue ? <span className="error">overdue</span> : null}
    </span>
  )
}

function Priority({ story }: { story: Story }) {
  const ed = useEditor('priority')
  if (!canRedefine(story)) return <span>{PRIORITY_LABEL[story.priority]}</span>
  return (
    <select value={story.priority} disabled={ed.saving} onChange={(e) => ed.save({ priority: e.target.value as StoryPriority })}>
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>
          {PRIORITY_LABEL[p]}
        </option>
      ))}
    </select>
  )
}

function Assignee({ story, members }: { story: Story; members: AssignableMember[] | null }) {
  if (!members) return <span>{story.assignee?.displayName ?? 'Unassigned'}</span>
  const known = !story.assignee || members.some((m) => m.user.id === story.assignee?.id)
  return (
    <select value={story.assignee?.id ?? ''} onChange={(e) => send({ type: 'assign', userId: e.target.value || null })}>
      <option value="">Unassigned</option>
      {!known && story.assignee ? <option value={story.assignee.id}>{story.assignee.displayName}</option> : null}
      {members.map((m) => (
        <option key={m.user.id} value={m.user.id}>
          {m.user.displayName}
        </option>
      ))}
    </select>
  )
}

function Blocker({ story }: { story: Story }) {
  const ed = useEditor('blocker')
  const [reason, setReason] = useState('')
  if (!story.actions.canEdit) return null
  if (story.isBlocked) {
    return (
      <button type="button" className="btn secondary" disabled={ed.saving} onClick={() => ed.save({ isBlocked: false })}>
        Clear blocker
      </button>
    )
  }
  if (!ed.editing) {
    return (
      <button type="button" className="btn ghost" onClick={() => ed.setEditing(true)}>
        Flag a blocker…
      </button>
    )
  }
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault()
        ed.save({ isBlocked: true, blockedReason: reason.trim() || null })
      }}
    >
      <input value={reason} maxLength={500} placeholder="What is blocking it? (optional)" onChange={(e) => setReason(e.target.value)} autoFocus disabled={ed.saving} />
      <div className="row">
        <button type="submit" className="btn" disabled={ed.saving}>
          Flag blocker
        </button>
        <button type="button" className="btn ghost" onClick={() => ed.setEditing(false)} disabled={ed.saving}>
          Cancel
        </button>
      </div>
    </form>
  )
}

export function OverviewTab({ story, branchName, members }: { story: Story; branchName: string; members: AssignableMember[] | null }) {
  const mine = story.actions.canReportWork
  return (
    <div className="overview">
      <div className="stack">
        {story.isBlocked ? <p className="notice error">Blocked{story.blockedReason ? `: ${story.blockedReason}` : ''}</p> : null}
        <Description story={story} />
        <Criteria story={story} />
      </div>
      <aside className="stack">
        <div className="card">
          <h3>Details</h3>
          <dl>
            <dt>Status</dt>
            <dd>{STATUS_LABEL[story.status]}</dd>
            <dt>Priority</dt>
            <dd>
              <Priority story={story} />
            </dd>
            <dt>Assignee</dt>
            <dd>
              <Assignee story={story} members={members} />
            </dd>
            <dt>Due</dt>
            <dd>
              <DueDate story={story} />
            </dd>
            <dt>Labels</dt>
            <dd>
              <Labels story={story} />
            </dd>
            <dt>Created by</dt>
            <dd>{story.createdBy.displayName}</dd>
            <dt>Updated</dt>
            <dd title={exactTime(story.updatedAt)}>{relativeTime(story.updatedAt)}</dd>
            <dt>Branch</dt>
            <dd className="mono">{branchName}</dd>
            {/* Picked when a run starts: the workflow the story's latest run used. */}
            <dt>Workflow</dt>
            <dd title={story.latestRun ? exactTime(story.latestRun.startedAt) : undefined}>
              {story.latestRun?.workflowName ? `${story.latestRun.workflowName} · ${story.latestRun.status.replace(/_/g, ' ')}` : <span className="muted">Not run yet</span>}
            </dd>
          </dl>
        </div>
        <div className="card">
          <h3>Actions</h3>
          <div className="buttons">
            {story.actions.canPickUp ? (
              <button type="button" className="btn" onClick={() => send({ type: 'action', action: 'pickUp' })}>
                Pick up
              </button>
            ) : null}
            {mine ? (
              <>
                <button type="button" className="btn" onClick={() => send({ type: 'action', action: 'createBranch' })}>
                  Create / switch to branch
                </button>
                <button type="button" className="btn secondary" onClick={() => send({ type: 'action', action: 'startWorkflow' })}>
                  Start workflow
                </button>
              </>
            ) : null}
            {story.actions.transitions.map((t) => (
              <button key={t.to} type="button" className="btn secondary" onClick={() => send({ type: 'move', to: t.to })}>
                {t.label}
              </button>
            ))}
            <Blocker story={story} />
            <button type="button" className="btn ghost" onClick={() => send({ type: 'action', action: 'copyBranch' })}>
              Copy branch name
            </button>
            <button type="button" className="btn ghost" onClick={() => send({ type: 'action', action: 'openInBrowser' })}>
              Open in browser
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}
