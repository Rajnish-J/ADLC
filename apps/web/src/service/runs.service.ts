// Run records: the runs table (with filters), one run in full, its diff, the Runs dashboard, people's feedback, the
// helpfulness of the memory it was given, and its AI summary.

import { z } from 'zod'
import {
  PatchSchema,
  ProjectRunDetailSchema,
  ProjectRunSchema,
  RunFeedbackSchema,
  RunInsightSchema,
  RunStatsSchema,
  type Patch,
  type ProjectRun,
  type ProjectRunDetail,
  type RunFeedback,
  type RunFeedbackInput,
  type RunInsight,
  type RunKind,
  type RunStats,
} from '@sdlc/contracts'
import { apiRequest } from './http'

const runsPath = (key: string): string => `/projects/${encodeURIComponent(key)}/runs`
const runPath = (key: string, id: string): string => `${runsPath(key)}/${encodeURIComponent(id)}`

export interface RunFilters {
  kind?: RunKind
  user?: string
  /** Runs that changed a file whose path contains this text. */
  file?: string
}

/** The project's runs, newest first (at most 200), narrowed on the server by kind, person or file. */
export function listProjectRuns(key: string, filters: RunFilters = {}): Promise<ProjectRun[]> {
  const params = new URLSearchParams({ limit: '200' })
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.user) params.set('user', filters.user)
  if (filters.file?.trim()) params.set('file', filters.file.trim())
  return apiRequest(`${runsPath(key)}?${params.toString()}`, z.array(ProjectRunSchema))
}

export function getRunDetail(key: string, id: string): Promise<ProjectRunDetail> {
  return apiRequest(runPath(key, id), ProjectRunDetailSchema)
}

/** The run's diff against the commit it started from. */
export function getRunDiff(key: string, id: string): Promise<Patch> {
  return apiRequest(`${runPath(key, id)}/diff`, PatchSchema)
}

export function getRunStats(key: string, days: number, user?: string): Promise<RunStats> {
  const params = new URLSearchParams({ days: String(days) })
  if (user) params.set('user', user)
  return apiRequest(`${runsPath(key)}/stats?${params.toString()}`, RunStatsSchema)
}

export function setRunFeedback(key: string, id: string, input: RunFeedbackInput): Promise<RunFeedback[]> {
  return apiRequest(`${runPath(key, id)}/feedback`, z.array(RunFeedbackSchema), { method: 'PUT', body: input })
}

export function setMemoryHelpful(key: string, id: string, itemId: string, helpful: boolean | null): Promise<{ ok: true }> {
  return apiRequest(`${runPath(key, id)}/memory/${encodeURIComponent(itemId)}/helpful`, z.object({ ok: z.literal(true) }), {
    method: 'PUT',
    body: { helpful },
  })
}

/** Write the AI summary of an ended run (`force` rewrites a current one). */
export function generateRunInsight(key: string, id: string, force = false): Promise<RunInsight> {
  return apiRequest(`${runPath(key, id)}/insights`, RunInsightSchema, { method: 'POST', body: { force } })
}
