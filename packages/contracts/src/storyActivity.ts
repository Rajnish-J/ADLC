// One story's history in words — "moved it from Ready to In progress", "set priority Medium → High" — shared by
// the web app's story page and the VS Code Story panel so both describe the same audit entries the same way.

import { STORY_PRIORITY_LABELS, STORY_STATUS_LABELS, type StoryPriority, type StoryStatus } from './stories'

/** The fields of an audit entry the description needs (an `AuditEntry` fits). */
export interface StoryActivityEntry {
  action: string
  data?: unknown
}

export interface DescribeStoryActivityOptions {
  /** How a `YYYY-MM-DD` due date is shown ("Nov 30"); defaults to the date as is. */
  formatDate?: (isoDate: string) => string
}

type Data = Record<string, unknown>

const status = (s: unknown): string => STORY_STATUS_LABELS[s as StoryStatus] ?? String(s)
const priority = (p: unknown): string => STORY_PRIORITY_LABELS[p as StoryPriority] ?? String(p)

function describeChanges(changes: Data, formatDate: (d: string) => string): string[] {
  const out: string[] = []
  const c = changes as Record<string, Data | undefined>
  if (c.title) out.push(`renamed it to “${String(c.title.to)}”`)
  if (c.priority) out.push(`set priority ${priority(c.priority.from)} → ${priority(c.priority.to)}`)
  if (c.dueDate) out.push(typeof c.dueDate.to === 'string' ? `set the due date to ${formatDate(c.dueDate.to)}` : 'cleared the due date')
  if (c.labels) {
    const added = (c.labels.added as string[] | undefined) ?? []
    const removed = (c.labels.removed as string[] | undefined) ?? []
    if (added.length > 0) out.push(`added label${added.length > 1 ? 's' : ''} ${added.join(', ')}`)
    if (removed.length > 0) out.push(`removed label${removed.length > 1 ? 's' : ''} ${removed.join(', ')}`)
  }
  if (c.blocked) out.push(c.blocked.to ? `flagged a blocker${c.blocked.reason ? `: ${String(c.blocked.reason)}` : ''}` : 'cleared the blocker')
  if (c.criteria) {
    const met = (c.criteria.met as string[] | undefined) ?? []
    const unmet = (c.criteria.unmet as string[] | undefined) ?? []
    if (met.length > 0) out.push(`met “${met.join('”, “')}”`)
    if (unmet.length > 0) out.push(`unticked “${unmet.join('”, “')}”`)
  }
  return out
}

/** What happened, as a phrase after the actor's name ("Leela Lead moved it from Ready to In progress"). */
export function describeStoryActivity(entry: StoryActivityEntry, opts: DescribeStoryActivityOptions = {}): string {
  const formatDate = opts.formatDate ?? ((d: string) => d)
  const d = (entry.data ?? {}) as Data
  switch (entry.action) {
    case 'story.created':
      if (d.source === 'azure-boards') return `imported it from Azure Boards (work item #${String(d.workItem)}) in ${status(d.status)}`
      return `created the story in ${status(d.status)}`
    case 'story.synced': {
      const what = d.to ? `moved it from ${status(d.from)} to ${status(d.to)} (Azure Boards: ${String(d.state)})` : 'updated it'
      return `${what} — synced from work item #${String(d.workItem)}`
    }
    case 'story.updated': {
      const detail = d.changes ? describeChanges(d.changes as Data, formatDate) : []
      if (detail.length > 0) return detail.join('; ')
      return `edited ${((d.fields as string[] | undefined) ?? []).join(', ') || 'the story'}`
    }
    case 'story.transitioned':
      return `moved it from ${status(d.from)} to ${status(d.to)}`
    case 'story.picked_up':
      return 'picked it up'
    case 'story.assigned':
      return 'assigned it'
    case 'story.unassigned':
      return 'unassigned it'
    case 'story.reordered':
      return `reordered it in ${status(d.status)}`
    case 'commits.reported':
      return 'pushed commits'
    default:
      if (entry.action.startsWith('memory.')) return `${entry.action.slice(7).replace(/_/g, ' ')} a memory item${d.title ? ` “${String(d.title)}”` : ''}`
      if (entry.action.startsWith('run.')) return `agent run ${entry.action.slice(4).replace(/_/g, ' ')}${d.workflow ? ` (${String(d.workflow)})` : ''}`
      return entry.action.replace(/[._]/g, ' ')
  }
}
