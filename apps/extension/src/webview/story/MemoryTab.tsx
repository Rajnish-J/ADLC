// "Memory": what has been learned on this story (notes, decisions, run summaries) — add to it, promote items to
// project memory — and the project's accepted knowledge, searchable. Agents started on the story get both.

import { useEffect, useState } from 'react'
import type { MemoryItem, MemoryKind, Story } from '@sdlc/contracts'
import { cx, exactTime, KIND_LABEL, MEMORY_KINDS, relativeTime, send } from './api'

function FileRefs({ item }: { item: MemoryItem }) {
  if (item.fileRefs.length === 0) return null
  return (
    <div className="refs">
      {item.fileRefs.map((f) => (
        <button key={`${f.path}:${f.startLine ?? ''}`} type="button" className="link mono" onClick={() => send({ type: 'openFile', path: f.path, line: f.startLine })}>
          {f.path}
          {f.startLine ? `:${f.startLine}${f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : ''}` : ''}
        </button>
      ))}
    </div>
  )
}

function promotionLabel(item: MemoryItem): string | null {
  if (!item.promotion) return null
  if (item.promotion.status === 'accepted') return 'In project memory'
  if (item.promotion.status === 'proposed') return 'Proposed for project'
  if (item.promotion.status === 'rejected') return 'Not accepted for project'
  return null
}

function MemoryCard({ item, showStory }: { item: MemoryItem; showStory?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const long = item.content.length > 280
  const promotion = promotionLabel(item)
  return (
    <li className={cx('card', 'memory', item.status === 'archived' && 'archived')}>
      <div className="row">
        <span className={cx('pill', `kind-${item.kind}`)}>{KIND_LABEL[item.kind]}</span>
        {item.pinned ? <span className="tag ok">pinned</span> : null}
        {item.source === 'run' ? <span className="tag">from a run</span> : null}
        {item.source === 'story_done' ? <span className="tag">story roll-up</span> : null}
        {promotion ? <span className={cx('tag', item.promotion?.status === 'accepted' && 'ok')}>{promotion}</span> : null}
        {item.status === 'archived' ? <span className="tag">archived</span> : null}
        <span className="spacer" />
        <span className="muted" title={exactTime(item.createdAt)}>
          {item.author?.displayName ?? 'Platform'} · {relativeTime(item.createdAt)}
        </span>
      </div>
      <strong className="memory-title">{item.title}</strong>
      {showStory && item.storyKey ? <span className="muted"> · from {item.storyKey}</span> : null}
      {item.content ? <p className={cx('memory-content', long && !expanded && 'clamped')}>{item.content}</p> : null}
      {long ? (
        <button type="button" className="link" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
      <FileRefs item={item} />
      {item.actions.canPromote || item.actions.canArchive ? (
        <div className="row actions">
          {item.actions.canPromote ? (
            <button type="button" className="btn secondary small" onClick={() => send({ type: 'promoteMemory', id: item.id })}>
              Promote to project memory
            </button>
          ) : null}
          {item.actions.canArchive ? (
            <button type="button" className="btn ghost small" onClick={() => send({ type: 'archiveMemory', id: item.id })}>
              Archive
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function AddMemory() {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<MemoryKind>('note')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Add to memory
      </button>
    )
  }
  const submit = () => {
    if (!title.trim()) return
    send({ type: 'addMemory', kind, title: title.trim(), content: content.trim() })
    setTitle('')
    setContent('')
    setOpen(false)
  }
  return (
    <div className="card form">
      <div className="row">
        <label htmlFor="mem-kind">Kind</label>
        <select id="mem-kind" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
          {MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <input placeholder="What should be remembered? (title)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <textarea placeholder="Details — why, where, how (optional)" rows={4} value={content} maxLength={20_000} onChange={(e) => setContent(e.target.value)} />
      <div className="row">
        <button type="button" className="btn" disabled={!title.trim()} onClick={submit}>
          Save
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export function MemoryTab({ story, memory, projectMemory, projectQuery }: { story: Story; memory: MemoryItem[]; projectMemory: MemoryItem[]; projectQuery: string }) {
  const [showArchived, setShowArchived] = useState(false)
  const [query, setQuery] = useState(projectQuery)
  useEffect(() => setQuery(projectQuery), [projectQuery])
  const visible = memory.filter((m) => showArchived || m.status !== 'archived')
  const archived = memory.length - memory.filter((m) => m.status !== 'archived').length

  return (
    <div className="stack">
      <section>
        <div className="row">
          <h3 className="grow">This story’s memory ({visible.length})</h3>
          {archived ? (
            <label className="muted">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived ({archived})
            </label>
          ) : null}
        </div>
        <p className="muted">Notes, decisions and learnings from working on {story.key}. Agents started on this story are given them.</p>
        {story.actions.canAddMemory ? <AddMemory /> : null}
        {visible.length === 0 ? <p className="muted">Nothing recorded yet.</p> : <ul className="list">{visible.map((m) => <MemoryCard key={m.id} item={m} />)}</ul>}
      </section>
      <section>
        <h3>Project knowledge</h3>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            send({ type: 'searchProjectMemory', query })
          }}
        >
          <input className="grow" placeholder="Search project memory" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="submit" className="btn secondary">
            Search
          </button>
          {projectQuery ? (
            <button type="button" className="btn ghost" onClick={() => send({ type: 'searchProjectMemory', query: '' })}>
              Clear
            </button>
          ) : null}
        </form>
        {projectMemory.length === 0 ? (
          <p className="muted">{projectQuery ? 'Nothing matches.' : 'No project memory yet.'}</p>
        ) : (
          <ul className="list">{projectMemory.map((m) => <MemoryCard key={m.id} item={m} showStory />)}</ul>
        )}
      </section>
    </div>
  )
}
