import { z } from 'zod'
import { WorkflowSummarySchema } from '@sdlc/contracts'
import type { WorkflowSpec } from '@sdlc/core'

/** A WorkflowSpec as served by the API — checked for the shape the canvas relies on. */
export const WorkflowSpecSchema = z.custom<WorkflowSpec>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    (v as { specVersion?: number }).specVersion === 1 &&
    Array.isArray((v as { nodes?: [] }).nodes) &&
    Array.isArray((v as { edges?: [] }).edges),
  'Not a workflow spec',
)

export const WorkflowDetailSchema = WorkflowSummarySchema.extend({ spec: WorkflowSpecSchema })
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>
