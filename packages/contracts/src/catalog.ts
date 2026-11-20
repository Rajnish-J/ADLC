// Creating and editing the catalog: project workflows, and the platform's own agents and skills (source
// `platform` — defined on the platform rather than in a repository). Built-in and repo agents stay read-only here;
// they change by editing packages/core/agents or the repository.

import { z } from 'zod'
import type { WorkflowSpec } from '@sdlc/core'
import { PROJECT_ROLES } from './rbac'

const SLUG = /^[a-z0-9][a-z0-9-]*$/

/** Shallow shape check only — the server runs the full structural validation (validateWorkflowSpec). */
export const WorkflowSpecInputSchema = z.custom<WorkflowSpec>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    (v as { specVersion?: unknown }).specVersion === 1 &&
    Array.isArray((v as { nodes?: unknown }).nodes) &&
    Array.isArray((v as { edges?: unknown }).edges),
  { message: 'Not a workflow spec.' },
)

export const CreateWorkflowInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a workflow name.').max(100),
  description: z.string().trim().max(2000).default(''),
  spec: WorkflowSpecInputSchema,
  setAsDefault: z.boolean().default(false),
})
export type CreateWorkflowInput = z.input<typeof CreateWorkflowInputSchema>

export const UpdateWorkflowInputSchema = z.object({
  /** The version the edit is based on; a stale version is rejected with 409. */
  version: z.number().int(),
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(2000).optional(),
  spec: WorkflowSpecInputSchema.optional(),
})
export type UpdateWorkflowInput = z.input<typeof UpdateWorkflowInputSchema>

export const PlatformAgentFieldsSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(100),
  description: z.string().trim().min(1, 'Describe what it does.').max(500),
  category: z.string().trim().min(1).max(40).default('general'),
  sdlcStage: z.string().trim().min(1).max(40).default('implement'),
  tools: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  model: z.string().trim().max(120).nullable().default(null),
  minProjectRole: z.enum(PROJECT_ROLES).nullable().default(null),
  instructions: z.string().trim().min(1, 'Write the instructions.').max(20_000),
})

export const CreatePlatformAgentInputSchema = PlatformAgentFieldsSchema.extend({
  kind: z.enum(['agent', 'skill']).default('agent'),
  slug: z.string().trim().min(2).max(60).regex(SLUG, 'Use lowercase letters, digits and hyphens.'),
})
export type CreatePlatformAgentInput = z.input<typeof CreatePlatformAgentInputSchema>

export const UpdatePlatformAgentInputSchema = PlatformAgentFieldsSchema.partial()
export type UpdatePlatformAgentInput = z.input<typeof UpdatePlatformAgentInputSchema>
