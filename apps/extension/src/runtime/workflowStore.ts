// Phase 5A — workflow persistence.
//
// The workflows the extension offers are the platform's built-ins from @sdlc/core — "Story delivery" (the default)
// and "Quick fix" — the same two the SDLC platform seeds into every project, served in-memory and read-only, so the
// extension and the web app always show the same workflows. Files a workspace still has in `.sdlc/workflows/` are
// not listed any more (they stay on disk and still open by id, e.g. from an old run).
// Uses vscode.workspace.fs (same IO design as RunAuditStore) so it works in the web extension host.

import * as vscode from 'vscode'
import type { WorkflowSpec } from './spec'
import { QUICK_FIX_SPEC, STORY_DELIVERY_ID, STORY_DELIVERY_SPEC } from '@sdlc/core'
import { isWorkflowSpec, type WorkflowEntry, type WorkflowRepository } from './workflowRepository'

export { isWorkflowSpec, type WorkflowEntry, type WorkflowRepository } from './workflowRepository'

const DIR_SEGMENTS = ['.sdlc', 'workflows']

/** Id of the read-only default workflow. */
export const DEFAULT_WORKFLOW_ID = STORY_DELIVERY_ID
/** The read-only default workflow: the platform's "Story delivery". */
export const DEFAULT_WORKFLOW_SPEC = STORY_DELIVERY_SPEC
/** The previous default's id ("SDLC Default"): still resolves, to the current default, for old links and runs. */
const LEGACY_DEFAULT_ID = 'sdlc-default'

/** Id of the built-in "Quick fix" workflow (prompt-only runs). */
export const QUICK_FIX_WORKFLOW_ID = 'quick-fix'

/** True for the read-only default workflow (including its legacy id). */
export function isDefaultWorkflowId(id: string): boolean {
  return id === DEFAULT_WORKFLOW_ID || id === LEGACY_DEFAULT_ID
}

/** True for any built-in (read-only, in-memory) workflow. */
export function isBuiltinWorkflowId(id: string): boolean {
  return isDefaultWorkflowId(id) || id === QUICK_FIX_WORKFLOW_ID
}

/** The built-ins, in the order the platform lists them (default first). */
const BUILTINS: { id: string; spec: WorkflowSpec; isDefault: boolean }[] = [
  { id: DEFAULT_WORKFLOW_ID, spec: DEFAULT_WORKFLOW_SPEC, isDefault: true },
  { id: QUICK_FIX_WORKFLOW_ID, spec: QUICK_FIX_SPEC, isDefault: false },
]

function builtinSpec(id: string): WorkflowSpec | undefined {
  if (isDefaultWorkflowId(id)) return DEFAULT_WORKFLOW_SPEC
  return BUILTINS.find((b) => b.id === id)?.spec
}

/** Filesystem-safe file stem for a workflow name. */
function fileStem(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe || 'workflow'
}

/** Generate a unique id from a name + timestamp. */
function makeId(name: string): string {
  return `${fileStem(name)}-${Date.now()}`
}

export class WorkflowStore implements WorkflowRepository {
  private readonly dir: vscode.Uri

  /** `_globalState` is accepted for existing callers; nothing is seeded any more. */
  constructor(workspaceFolder: vscode.Uri, _globalState?: vscode.Memento) {
    this.dir = vscode.Uri.joinPath(workspaceFolder, ...DIR_SEGMENTS)
  }

  /** Resolve the store for the first workspace folder, or undefined when no folder is open. */
  static forActiveWorkspace(globalState?: vscode.Memento): WorkflowStore | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0]
    return folder ? new WorkflowStore(folder.uri, globalState) : undefined
  }

  uriFor(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, `${id}.json`)
  }

  /**
   * The 15-agent "SDLC Governance" template is no longer seeded (the platform retired it in favour of Story
   * delivery). Copies already saved in a workspace's .sdlc/workflows/ are left untouched.
   * @deprecated No-op; kept until the activation call is removed.
   */
  async seedGovernanceTemplate(): Promise<void> {}

  /** Write a spec as pretty JSON; id defaults to fileStem(name). Returns the uri it was saved to. */
  async save(spec: WorkflowSpec, id?: string): Promise<vscode.Uri> {
    await vscode.workspace.fs.createDirectory(this.dir)
    const resolvedId = id ?? fileStem(spec.name)
    const uri = this.uriFor(resolvedId)
    const body = Buffer.from(JSON.stringify(spec, null, 2) + '\n', 'utf8')
    await vscode.workspace.fs.writeFile(uri, body)
    return uri
  }

  /** Load and parse a spec from a uri. Throws a clear error on malformed JSON / wrong shape. */
  static async load(uri: vscode.Uri): Promise<WorkflowSpec> {
    const bytes = await vscode.workspace.fs.readFile(uri)
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
    } catch {
      throw new Error(`Not valid JSON: ${uri.fsPath}`)
    }
    if (!isWorkflowSpec(parsed)) {
      throw new Error(`Not a WorkflowSpec (expected specVersion + nodes + edges): ${uri.fsPath}`)
    }
    return parsed
  }

  async loadByName(name: string): Promise<WorkflowSpec | undefined> {
    try {
      return await WorkflowStore.load(this.uriFor(fileStem(name)))
    } catch {
      return undefined
    }
  }

  async loadById(id: string): Promise<WorkflowSpec | undefined> {
    const builtin = builtinSpec(id)
    if (builtin) return builtin
    try {
      return await WorkflowStore.load(this.uriFor(id))
    } catch {
      return undefined
    }
  }

  /**
   * The workflows to offer: the built-ins only (default first), exactly what the platform seeds into every project.
   * Files in .sdlc/workflows/ are intentionally not listed.
   */
  async listAll(): Promise<WorkflowEntry[]> {
    return BUILTINS.map((b) => ({ id: b.id, name: b.spec.name, description: b.spec.description, isDefault: b.isDefault, builtin: true }))
  }

  /**
   * Deep-copy a workflow under a new name. Returns the new workflow id.
   * The default project can be duplicated; the duplicate is always user-owned.
   */
  async duplicate(sourceId: string, newName: string): Promise<string> {
    const sourceSpec = await this.loadById(sourceId)
    if (!sourceSpec) throw new Error(`Workflow "${sourceId}" not found`)

    const newId = makeId(newName)
    const newSpec: WorkflowSpec = { ...sourceSpec, name: newName, description: `Copy of ${sourceSpec.name}` }
    await this.save(newSpec, newId)
    return newId
  }

  /**
   * Delete a user workflow by id. Refuses to delete the read-only default.
   */
  async delete(id: string): Promise<void> {
    if (isBuiltinWorkflowId(id)) {
      throw new Error(`The built-in "${builtinSpec(id)?.name}" workflow cannot be deleted.`)
    }
    const uri = this.uriFor(id)
    await vscode.workspace.fs.delete(uri)
  }

  /** Rename a user workflow. */
  async rename(id: string, newName: string): Promise<void> {
    if (isBuiltinWorkflowId(id)) {
      throw new Error(`The built-in "${builtinSpec(id)?.name}" workflow cannot be renamed.`)
    }
    const spec = await this.loadById(id)
    if (!spec) throw new Error(`Workflow "${id}" not found`)
    const updated: WorkflowSpec = { ...spec, name: newName }
    await this.save(updated, id)
  }
}
