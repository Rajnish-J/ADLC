// The Story panel: header, tabs (Overview · Memory · Code & runs), notices. State comes from the host; every
// change goes back to it as a message (the host calls the platform API and pushes fresh state).

import { useEffect, useState } from 'react'
import { diffKey, type ActivityLine, type DiffRef, type StoryPanelData } from '../../platform/storyPanel/storyPanelMessages'
import { ActivityTab } from './ActivityTab'
import { cx, onHostMessage, PRIORITY_LABEL, send, STATUS_LABEL } from './api'
import { CodeTab, type DiffState } from './CodeTab'
import { MemoryTab } from './MemoryTab'
import { EditableTitle, OverviewTab } from './OverviewTab'

type Tab = 'overview' | 'memory' | 'code' | 'activity'

export function StoryApp() {
  const [data, setData] = useState<StoryPanelData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('overview')
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; message: string } | null>(null)
  // Pages of activity loaded past the first (which arrives with every state refresh).
  const [older, setOlder] = useState<{ lines: ActivityLine[]; hasMore: boolean } | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)

  useEffect(() => {
    const off = onHostMessage((msg) => {
      switch (msg.type) {
        case 'state':
          setData(msg.data)
          break
        case 'olderActivity':
          setLoadingOlder(false)
          setOlder((prev) => ({ lines: [...(prev?.lines ?? []), ...msg.lines], hasMore: msg.hasMore }))
          break
        case 'loading':
          setLoading(msg.loading)
          break
        case 'diff':
          setDiffs((prev) => ({ ...prev, [msg.key]: { loading: false, patch: msg.patch?.patch ?? null, truncated: msg.patch?.patchTruncated, error: msg.error } }))
          break
        case 'projectMemory':
          setData((prev) => (prev ? { ...prev, projectMemory: msg.items, projectQuery: msg.query } : prev))
          break
        case 'notice':
          if (msg.kind === 'error') setLoadingOlder(false)
          setNotice({ kind: msg.kind, message: msg.message })
          break
      }
    })
    send({ type: 'ready' })
    return off
  }, [])

  useEffect(() => {
    if (!notice || notice.kind === 'error') return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  const loadDiff = (ref: DiffRef) => {
    setDiffs((prev) => ({ ...prev, [diffKey(ref)]: { loading: true } }))
    send({ type: 'loadDiff', key: diffKey(ref), ref })
  }

  if (!data) {
    return <div className="empty">{notice?.kind === 'error' ? <p className="error">{notice.message}</p> : <p className="muted">Loading story…</p>}</div>
  }

  const { story, work } = data
  const liveCount = work?.workspaces.filter((w) => Date.now() - new Date(w.updatedAt).getTime() < 120_000 && w.files.length > 0).length ?? 0
  const memoryCount = data.memory.filter((m) => m.status !== 'archived').length
  const workCount = (work?.commits.length ?? 0) + (work?.runs.length ?? 0)
  // First page (fresh on every refresh) plus older pages, without duplicates where they overlap.
  const firstIds = new Set(data.activity.map((l) => l.id))
  const activity = [...data.activity, ...(older?.lines.filter((l) => !firstIds.has(l.id)) ?? [])]
  const activityHasMore = older ? older.hasMore : data.activityHasMore

  return (
    <div className="app">
      <header className="header">
        <div className="row">
          <span className="key mono">{story.key}</span>
          <span className={cx('pill', `status-${story.status}`)}>{STATUS_LABEL[story.status]}</span>
          <span className={cx('pill', `priority-${story.priority}`)}>{PRIORITY_LABEL[story.priority]}</span>
          {story.isBlocked ? <span className="pill blocked">Blocked</span> : null}
          {liveCount ? <span className="pill live">● {liveCount} working now</span> : null}
          <span className="spacer" />
          {loading ? <span className="muted">Refreshing…</span> : null}
          <button type="button" className="btn ghost small" onClick={() => send({ type: 'refresh' })} title="Reload from the platform">
            Refresh
          </button>
        </div>
        <EditableTitle story={story} />
      </header>

      {notice ? (
        <div className={cx('notice', notice.kind === 'error' && 'error')} role="status">
          {notice.message}
          <button type="button" className="link" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {data.error ? <p className="notice error">{data.error}</p> : null}

      <nav className="tabs" role="tablist">
        {(
          [
            ['overview', 'Overview', null],
            ['memory', 'Memory', memoryCount],
            ['code', 'Code & runs', workCount],
            ['activity', 'Activity', null],
          ] as const
        ).map(([id, label, count]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={cx('tab', tab === id && 'active')} onClick={() => setTab(id)}>
            {label}
            {count ? <span className="count">{count}</span> : null}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'overview' ? <OverviewTab story={story} branchName={data.branchName} members={data.members} /> : null}
        {tab === 'memory' ? <MemoryTab story={story} memory={data.memory} projectMemory={data.projectMemory} projectQuery={data.projectQuery} /> : null}
        {tab === 'code' ? <CodeTab work={work} tracking={data.tracking} diffs={diffs} onLoadDiff={loadDiff} /> : null}
        {tab === 'activity' ? <ActivityTab
            lines={activity}
            hasMore={activityHasMore}
            loadingMore={loadingOlder}
            onLoadOlder={(before) => {
              setLoadingOlder(true)
              send({ type: 'loadOlderActivity', before })
            }}
          /> : null}
      </main>
    </div>
  )
}
