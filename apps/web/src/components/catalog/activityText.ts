import { z } from 'zod'
import { STORY_STATUS_LABELS, PROJECT_ROLE_LABELS, type AuditEntry } from '@sdlc/contracts'

/** The audit `data` fields the activity feed knows how to describe. */
const ActivityDataSchema = z
  .object({
    key: z.string(),
    title: z.string(),
    name: z.string(),
    from: z.string(),
    to: z.string(),
    role: z.string(),
    email: z.string(),
    slug: z.string(),
    fields: z.array(z.string()),
    count: z.number(),
    branch: z.string(),
    workflow: z.string(),
    step: z.string(),
    approve: z.boolean(),
    scope: z.string(),
    kind: z.string(),
    repository: z.string(),
    provider: z.string(),
    previous: z.string(),
    token: z.string(),
    error: z.string(),
    sha: z.string(),
    message: z.string(),
    paths: z.array(z.string()),
    added: z.number(),
    updated: z.number(),
    removed: z.number(),
    agents: z.number(),
    skills: z.number(),
  })
  .partial()

const statusLabel = (s: string | undefined): string => (s && s in STORY_STATUS_LABELS ? STORY_STATUS_LABELS[s as keyof typeof STORY_STATUS_LABELS] : (s ?? ''))
const roleLabel = (r: string | undefined): string => (r && r in PROJECT_ROLE_LABELS ? PROJECT_ROLE_LABELS[r as keyof typeof PROJECT_ROLE_LABELS] : (r ?? ''))

/** One readable line for an audit entry, e.g. "moved PAY-2 from In progress to In review". */
export function describeActivity(entry: AuditEntry): string {
  const parsed = ActivityDataSchema.safeParse(entry.data)
  const d = parsed.success ? parsed.data : {}
  switch (entry.action) {
    case 'project.created':
      return `created the project ${d.name ?? ''}`.trim()
    case 'story.created':
      return `created ${d.key}${d.title ? ` — ${d.title}` : ''}`
    case 'story.updated':
      return `edited ${d.key}${d.fields?.length ? ` (${d.fields.join(', ')})` : ''}`
    case 'story.transitioned':
      return `moved ${d.key} from ${statusLabel(d.from)} to ${statusLabel(d.to)}`
    case 'story.picked_up':
      return `picked up ${d.key}`
    case 'story.assigned':
      return `assigned ${d.key}`
    case 'story.unassigned':
      return `unassigned ${d.key}`
    case 'member.added':
      return `added ${d.email} as ${roleLabel(d.role)}`
    case 'member.role_changed':
      return `changed a member's role from ${roleLabel(d.from)} to ${roleLabel(d.to)}`
    case 'member.removed':
      return `removed a ${roleLabel(d.role).toLowerCase()} from the project`
    case 'agent.enabled':
      return `enabled the ${d.slug} agent`
    case 'agent.disabled':
      return `disabled the ${d.slug} agent`
    case 'workflow.step_mapped':
      return d.to ? `mapped ${d.workflow} › ${d.step} to the ${d.to} agent` : `removed the agent from ${d.workflow} › ${d.step}`
    case 'commits.reported':
      return `committed ${d.count === 1 ? 'a change' : `${d.count} changes`} to ${d.key}${d.branch ? ` on ${d.branch}` : ''}`
    case 'run.started':
      return `started “${d.workflow}” on ${d.key}`
    case 'run.completed':
      return `“${d.workflow}” completed on ${d.key}`
    case 'run.failed':
      return `“${d.workflow}” failed on ${d.key}`
    case 'run.cancelled':
      return `cancelled “${d.workflow}” on ${d.key}`
    case 'run.approval_decided':
      return `${d.approve ? 'approved' : 'rejected'} “${d.step}” in ${d.key}`
    case 'memory.added':
      return `added ${d.scope === 'project' ? 'to project memory' : `to ${d.key}'s memory`}: ${d.title}`
    case 'memory.proposed':
      return `proposed for project memory: ${d.title}`
    case 'memory.promoted':
    case 'memory.accepted':
      return `added to project memory: ${d.title}`
    case 'memory.rejected':
      return `rejected a memory proposal: ${d.title}`
    case 'memory.updated':
      return `edited memory: ${d.title}`
    case 'memory.pinned':
      return `pinned for every agent: ${d.title}`
    case 'memory.unpinned':
      return `unpinned: ${d.title}`
    case 'memory.archived':
      return `archived memory: ${d.title}`
    case 'project.updated':
      return 'edited the project details'
    case 'project.settings_updated':
      return 'changed the project’s agent engines'
    case 'project.archived':
      return `archived the project ${d.name ?? ''}`.trim()
    case 'project.restored':
      return `restored the project ${d.name ?? ''}`.trim()
    case 'repo.linked':
      return d.provider === 'workspace' ? 'started a blank workspace' : `linked the repository ${d.repository}`
    case 'repo.updated':
      return d.previous
        ? `switched the repository from ${d.previous} to ${d.repository}`
        : `updated the repository settings${d.token ? ` (token ${d.token})` : ''}`
    case 'repo.unlinked':
      return `disconnected the repository ${d.repository}`
    case 'repo.synced':
      return `synced ${d.repository} — ${d.agents ?? 0} agents and ${d.skills ?? 0} skills`
    case 'repo.sync_failed':
      return `tried to sync ${d.repository}: ${d.error}`
    case 'agents.synced':
      return `updated agents and skills from ${d.branch ?? 'the repository'} (+${d.added ?? 0} ~${d.updated ?? 0} −${d.removed ?? 0})`
    case 'code.committed':
      return `committed ${d.paths?.length === 1 ? d.paths[0] : `${d.paths?.length ?? 0} files`} to ${d.branch}${d.message ? ` — “${d.message}”` : ''}`
    case 'code.file_created':
      return `created ${d.paths?.[0] ?? 'a file'}`
    case 'code.file_deleted':
      return `deleted ${d.paths?.[0] ?? 'a file'}`
    case 'repo.published':
      return `published the workspace to ${d.repository}`
    case 'code.branch_created':
      return `created the branch ${d.branch}${d.from ? ` from ${d.from}` : ''}`
    default:
      return entry.action
  }
}
