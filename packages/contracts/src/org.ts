// Organisation administration (org admins): the people in the organisation and their org role, archived projects,
// and the server's health as the Settings page shows it.

import { z } from 'zod'
import { ORG_ROLES, PROJECT_ROLES } from './rbac'
import { UserSchema } from './schemas'

export const OrgPersonSchema = z.object({
  user: UserSchema,
  lastSeenAt: z.string().nullable(),
  projects: z.array(z.object({ key: z.string(), name: z.string(), role: z.enum(PROJECT_ROLES) })),
})
export type OrgPerson = z.infer<typeof OrgPersonSchema>

export const OrgPeopleSchema = z.object({
  organization: z.object({ name: z.string(), slug: z.string() }),
  people: z.array(OrgPersonSchema),
})
export type OrgPeople = z.infer<typeof OrgPeopleSchema>

export const UpdateOrgRoleInputSchema = z.object({ orgRole: z.enum(ORG_ROLES) })
export type UpdateOrgRoleInput = z.infer<typeof UpdateOrgRoleInputSchema>

export const ArchivedProjectSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  archivedAt: z.string(),
})
export type ArchivedProject = z.infer<typeof ArchivedProjectSchema>

/** What the System section shows. Never contains secrets (no keys, tokens or connection strings). */
export const SystemStatusSchema = z.object({
  api: z.object({
    version: z.string(),
    nodeVersion: z.string(),
    environment: z.string(),
    authMode: z.string(),
    startedAt: z.string(),
  }),
  database: z.object({
    ok: z.boolean(),
    latencyMs: z.number().nullable(),
    migrationsApplied: z.number().int().nullable(),
    error: z.string().nullable(),
  }),
  git: z.object({ ok: z.boolean(), version: z.string().nullable(), error: z.string().nullable() }),
  /** The orchestrator service (catalog + platform-driven runs). Absent from older servers. */
  orchestrator: z.object({ ok: z.boolean(), url: z.string(), detail: z.string() }).optional(),
  repositories: z.object({
    /** False when the development fallback key encrypts the tokens. */
    credentialKeyConfigured: z.boolean(),
    maxFileBytes: z.number().int(),
    maxFiles: z.number().int(),
    jobConcurrency: z.number().int(),
    gitTimeoutMs: z.number().int(),
    jobsRunning: z.number().int(),
    jobsQueued: z.number().int(),
  }),
  counts: z.object({
    projects: z.number().int(),
    archivedProjects: z.number().int(),
    repositories: z.number().int(),
    gitConnections: z.number().int(),
    people: z.number().int(),
  }),
})
export type SystemStatus = z.infer<typeof SystemStatusSchema>
