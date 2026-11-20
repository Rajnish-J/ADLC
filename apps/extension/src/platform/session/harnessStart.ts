// Starting a project workflow from VS Code in the user's selected harness — the pickers shared by every Start
// entry point (the canvas ▶ Start, "Run Workflow", the Story panel / tree "Start Workflow"). The run itself is
// requested and launched by HarnessSessions.startLocal (via `sdlcGovernance.platform.startInHarness`), exactly as
// a run started from the web: same API request, claim, MCP wiring and reporting.
//
// Harness choice follows the platform: only harnesses installed in this window AND allowed by the project are
// offered, and the user's effective engine (their preference if the project allows it, else the project default)
// is preselected — it starts without asking when it is the only option.

import * as vscode from 'vscode'
import {
  effectiveEngine,
  harnessLabel,
  isHarnessAllowed,
  parseRepoUrl,
  HARNESS_TIER_LABELS,
  type ProjectSummary,
  type Story,
  type StoryTask,
} from '@sdlc/contracts'
import { getOriginRemote, getRepository } from '../../integrations/git/gitRepository'
import type { PlatformClient } from '../platformClient'
import { installed } from '../engines/registry'

/** The built-in runtime (agents on VS Code language models, in-process) — offered where a caller supports it. */
export const BUILTIN_RUNTIME = 'builtin'

export interface HarnessPick {
  /** A harness id, or BUILTIN_RUNTIME. */
  engine: string
  label: string
}

/**
 * Ask which harness to run in. Installed ∩ allowed by the project, the effective engine first and marked; skips
 * the question when exactly one harness qualifies and the built-in runtime is not offered.
 */
export async function pickHarness(
  client: PlatformClient,
  project: ProjectSummary,
  opts: { title: string; offerBuiltin?: boolean },
): Promise<HarnessPick | undefined> {
  const prefs = await client
    .mySettings()
    .then((s) => s.preferences)
    .catch(() => undefined)
  const preferred = effectiveEngine(prefs?.agentEngine ?? null, project.settings)
  const here = installed()
  const allowed = here.filter((h) => isHarnessAllowed(h.id, project.settings.allowedEngines))
  allowed.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred))

  if (allowed.length === 0) {
    const why = here.length
      ? `${project.key} allows ${project.settings.allowedEngines.map(harnessLabel).join(', ')}, and none of them is installed in this window.`
      : 'No coding harness (Copilot, Claude Code, Codex…) is installed in this window.'
    if (!opts.offerBuiltin) {
      void vscode.window.showWarningMessage(`${why} Install one to start runs here.`)
      return undefined
    }
    const go = await vscode.window.showWarningMessage(why, 'Use Built-in Runtime')
    return go ? { engine: BUILTIN_RUNTIME, label: 'Built-in runtime' } : undefined
  }
  if (allowed.length === 1 && !opts.offerBuiltin) return { engine: allowed[0].id, label: allowed[0].label }

  type Item = vscode.QuickPickItem & { engine: string }
  const items: Item[] = allowed.map((h) => ({
    label: `$(hubot) ${h.label}`,
    description: [h.id === preferred ? 'your default' : undefined, h.version ?? undefined, HARNESS_TIER_LABELS[h.tier]].filter(Boolean).join(' · '),
    engine: h.id,
    picked: h.id === preferred,
  }))
  if (opts.offerBuiltin) {
    items.push({ label: '$(gear) Built-in runtime', description: 'Agents run on VS Code language models in this window', engine: BUILTIN_RUNTIME })
  }
  const picked = await vscode.window.showQuickPick(items, { title: opts.title, placeHolder: 'Where should this run?' })
  return picked ? { engine: picked.engine, label: picked.label.replace(/^\$\([^)]+\)\s*/, '') } : undefined
}

/** The platform project whose linked repository is this workspace's `origin`, if any. */
export async function workspaceProject(projects: ProjectSummary[]): Promise<ProjectSummary | undefined> {
  const repo = await getRepository().catch(() => undefined)
  const remote = repo ? getOriginRemote(repo) : undefined
  const url = remote?.fetchUrl ?? remote?.pushUrl
  if (!url) return undefined
  const parsed = parseRepoUrl(url)
  if (!parsed.ok) return undefined
  const name = parsed.repo.displayName.toLowerCase()
  return projects.find((p) => p.repository?.displayName.toLowerCase() === name)
}

/** Whether this workspace's `origin` is the project's linked repository (true when either side is unknown). */
export async function workspaceMatchesProject(project: ProjectSummary): Promise<boolean> {
  if (!project.repository) return true
  return (await workspaceProject([project])) !== undefined || !(await getRepository().catch(() => undefined))
}

/** The project to run in: the one this workspace belongs to, else the user picks. */
export async function pickProject(client: PlatformClient, preferKey?: string): Promise<ProjectSummary | undefined> {
  const projects = await client.projects()
  if (preferKey) {
    const p = projects.find((x) => x.key === preferKey)
    if (p) return p
  }
  const mine = await workspaceProject(projects)
  if (mine) return mine
  if (projects.length === 1) return projects[0]
  const picked = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: p.name, description: p.key, detail: p.repository?.displayName, p })),
    { title: 'Which project is this run for?' },
  )
  return picked?.p
}

/** A story to run on (mine in the project first), then optionally one of its tasks. */
export async function pickStoryAndTask(
  client: PlatformClient,
  project: ProjectSummary,
): Promise<{ story: Story; taskNumber: number | null } | undefined> {
  const [mine, all] = await Promise.all([client.myStories().catch(() => [] as Story[]), client.stories(project.key)])
  const myIds = new Set(mine.filter((s) => s.projectKey === project.key).map((s) => s.id))
  const open = all.filter((s) => s.status !== 'done')
  open.sort((a, b) => Number(myIds.has(b.id)) - Number(myIds.has(a.id)) || a.number - b.number)
  if (open.length === 0) {
    void vscode.window.showWarningMessage(`${project.key} has no open stories to run on. Create or sync one first.`)
    return undefined
  }
  type Item = vscode.QuickPickItem & { story?: Story }
  const items: Item[] = []
  let section: boolean | undefined
  for (const s of open) {
    const isMine = myIds.has(s.id)
    if (section !== isMine) {
      items.push({ label: isMine ? 'Assigned to me' : 'Other open stories', kind: vscode.QuickPickItemKind.Separator })
      section = isMine
    }
    items.push({ label: `${s.key} · ${s.title}`, description: s.status.replace('_', ' '), detail: s.assignee?.displayName, story: s })
  }
  const picked = await vscode.window.showQuickPick(items, { title: `Run on which ${project.key} story?`, matchOnDetail: true })
  const story = picked?.story
  if (!story) return undefined

  const tasks = await client.storyTasks(project.key, story.number).catch(() => [] as StoryTask[])
  const openTasks = tasks.filter((t) => t.status !== 'done')
  if (openTasks.length === 0) return { story, taskNumber: null }
  type TaskItem = vscode.QuickPickItem & { taskNumber: number | null }
  const task = await vscode.window.showQuickPick<TaskItem>(
    [
      { label: '$(book) Whole story', description: story.key, taskNumber: null },
      ...openTasks.map((t): TaskItem => ({ label: `$(tasklist) ${t.key} · ${t.title}`, description: t.status.replace('_', ' '), taskNumber: t.number })),
    ],
    { title: `${story.key}: the whole story or one task?` },
  )
  return task ? { story, taskNumber: task.taskNumber } : undefined
}

/**
 * Start a project workflow in a harness: story (unless given) → harness → HarnessSessions.startLocal. Returns
 * 'started', 'builtin' when the user chose the built-in runtime (the caller runs it), or undefined when cancelled.
 */
export async function startProjectWorkflow(
  client: PlatformClient,
  input: { project: ProjectSummary; workflowId: string; workflowName: string; story?: Story; taskNumber?: number | null; offerBuiltin?: boolean },
): Promise<'started' | 'builtin' | undefined> {
  const target = input.story ? { story: input.story, taskNumber: input.taskNumber ?? null } : await pickStoryAndTask(client, input.project)
  if (!target) return undefined
  const where = await pickHarness(client, input.project, {
    title: `Run ${input.workflowName} on ${target.story.key} in…`,
    offerBuiltin: input.offerBuiltin,
  })
  if (!where) return undefined
  if (where.engine === BUILTIN_RUNTIME) return 'builtin'
  if (!(await workspaceMatchesProject(input.project))) {
    const go = await vscode.window.showWarningMessage(
      `This window's repository isn't ${input.project.repository?.displayName ?? input.project.key}'s. Agents will work on the files open here.`,
      { modal: true },
      'Continue',
    )
    if (go !== 'Continue') return undefined
  }
  await vscode.commands.executeCommand('sdlcGovernance.platform.startInHarness', target.story, input.workflowId, where.engine, target.taskNumber)
  return 'started'
}

/**
 * Start one of this workspace's local workflows (the canvas ▶ Start). Harness runs need the platform: signed out,
 * the user can sign in or use the built-in runtime. Signed in, the local default ("Story delivery") runs as the
 * project's default workflow — the same spec, with the project's agent mapping — in the selected harness. A custom
 * local workflow has no project counterpart, so it runs on the built-in runtime unless the user picks the
 * project's default instead. Returns 'builtin' when the caller should run it in-process.
 */
export async function startLocalWorkflow(
  client: PlatformClient | undefined,
  local: { name: string; isDefault: boolean },
): Promise<'started' | 'builtin' | undefined> {
  if (!client) {
    const go = await vscode.window.showInformationMessage(
      'Sign in to the SDLC platform to run this workflow in your harness (Copilot, Claude Code, Codex…).',
      { detail: 'Without signing in, it can run on the built-in runtime (VS Code language models, in this window).' },
      'Sign In',
      'Use Built-in Runtime',
    )
    if (go === 'Sign In') await vscode.commands.executeCommand('sdlcGovernance.platform.connect')
    return go === 'Use Built-in Runtime' ? 'builtin' : undefined
  }
  const project = await pickProject(client)
  if (!project) return undefined
  const workflows = await client.workflows(project.key)
  const projectDefault = workflows.find((w) => w.isDefault) ?? workflows[0]
  if (!projectDefault) {
    const go = await vscode.window.showWarningMessage(`${project.key} has no workflows to run in a harness.`, 'Use Built-in Runtime')
    return go ? 'builtin' : undefined
  }
  if (!local.isDefault) {
    const go = await vscode.window.showInformationMessage(
      `“${local.name}” is a local workflow. Harness runs use ${project.key}'s workflows, which carry the project's agent mapping.`,
      { modal: true, detail: `Run it on the built-in runtime, or run ${project.key}'s “${projectDefault.name}” in your harness instead.` },
      `Run ${projectDefault.name} in Harness`,
      'Use Built-in Runtime',
    )
    if (go === 'Use Built-in Runtime') return 'builtin'
    if (!go) return undefined
  }
  return startProjectWorkflow(client, { project, workflowId: projectDefault.id, workflowName: projectDefault.name, offerBuiltin: true })
}
