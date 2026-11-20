// Where workflow specs live, as an interface: the workspace's `.sdlc/workflows` folder in local mode
// (WorkflowStore), the project's workflows on the backend in connected mode. Framework-free so the
// validator and the contract can be shared outside the extension.

import type { WorkflowSpec } from './spec'

export interface WorkflowEntry {
  id: string
  name: string
  description: string
  isDefault: boolean
  /** Ships with the extension (and the platform): read-only, served in-memory. */
  builtin?: boolean
}

export interface WorkflowRepository {
  listAll(): Promise<WorkflowEntry[]>
  loadById(id: string): Promise<WorkflowSpec | undefined>
  loadByName(name: string): Promise<WorkflowSpec | undefined>
  /** Resolves to an implementation-specific handle (a file URI locally, a version id remotely). */
  save(spec: WorkflowSpec, id?: string): Promise<unknown>
  /** Copies a workflow under a new name; resolves to the new workflow's id. */
  duplicate(sourceId: string, newName: string): Promise<string>
  delete(id: string): Promise<void>
  rename(id: string, newName: string): Promise<void>
}

/** Narrow an unknown parsed value to a WorkflowSpec (defensive — files are user-editable on disk). */
export function isWorkflowSpec(v: unknown): v is WorkflowSpec {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return o.specVersion === 1 && Array.isArray(o.nodes) && Array.isArray(o.edges) && typeof o.name === 'string'
}
