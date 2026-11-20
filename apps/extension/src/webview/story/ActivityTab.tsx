// "Activity": the story's history — moves, edits (with what changed), memory and agent runs — newest first, the
// same feed as the web app's story page. Older entries load on demand.

import type { ActivityLine } from '../../platform/storyPanel/storyPanelMessages'
import { exactTime, relativeTime } from './api'

interface Props {
  lines: ActivityLine[]
  hasMore: boolean
  loadingMore: boolean
  /** Load the page after the entry with id `before`. */
  onLoadOlder: (before: number) => void
}

export function ActivityTab({ lines, hasMore, loadingMore, onLoadOlder }: Props) {
  if (lines.length === 0) return <p className="muted">No activity yet.</p>
  return (
    <div className="stack">
      <ul className="list activity">
        {lines.map((l) => (
          <li key={l.id} className="activity-line">
            <span>
              <strong>{l.actor ?? 'System'}</strong> {l.text}
            </span>
            <span className="muted" title={exactTime(l.createdAt)}>
              {relativeTime(l.createdAt)}
              {l.via ? ` · via ${l.via}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {hasMore ? (
        <div>
          <button type="button" className="btn ghost" disabled={loadingMore} onClick={() => onLoadOlder(lines[lines.length - 1].id)}>
            {loadingMore ? 'Loading…' : 'Load older'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
