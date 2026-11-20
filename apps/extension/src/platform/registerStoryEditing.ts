// Story and project-memory management from VS Code — what the web app's board, story page and Memory page offer:
// create a story, assign it, add project memory directly, pin / unpin it for every agent, and clone or open the
// project's linked repository. Editing a story's fields happens in the Story panel. The API enforces every
// permission; menus only hide what the user can't do.

import * as vscode from 'vscode'
import {
  MEMORY_KIND_LABELS,
  PROJECT_ROLE_LABELS,
  STORY_PRIORITIES,
  type MemoryKind,
  type ProjectSummary,
  type Story,
  type StoryPriority,
} from '@sdlc/contracts'
import { getGitApi, getOriginRemote } from '../integrations/git/gitRepository'
import type { PlatformClient } from './platformClient'
import { canIn, type PlatformHandle } from './platformHandle'
import type { PlatformNode } from './platformStoriesProvider'
import { sameRepository } from './storyFormat'

type MemoryNode = Extract<PlatformNode, { kind: 'memoryItem' }>

const PRIORITY_LABEL: Record<StoryPriority, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }

export function registerStoryEditing(context: vscode.ExtensionContext, platform: PlatformHandle): void {
  const withClient = async <T>(action: (c: PlatformClient) => Promise<T>): Promise<T | undefined> => {
    const client = platform.client()
    if (!client) {
      void vscode.window.showWarningMessage('Connect to the SDLC platform first.')
      return undefined
    }
    try {
      return await action(client)
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err))
      return undefined
    }
  }

  // The SSE stream refreshes the tree too; this covers a stream that is reconnecting.
  const refreshStories = () => void vscode.commands.executeCommand('sdlcGovernance.platform.refresh')

  /** The project an action targets: the tree row's, else a pick among projects where `allowed` holds. */
  const resolveProject = async (node: PlatformNode | undefined, allowed: (p: ProjectSummary) => boolean, what: string): Promise<ProjectSummary | undefined> => {
    if (node && 'project' in node) return node.project
    const projects = await withClient(async (c) => {
      await platform.ensureMe()
      return c.projects()
    })
    if (!projects) return undefined
    const candidates = projects.filter(allowed)
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(`You can't ${what} in any project.`)
      return undefined
    }
    if (candidates.length === 1) return candidates[0]
    const picked = await vscode.window.showQuickPick(
      candidates.map((p) => ({ label: p.key, description: p.name, project: p })),
      { title: `Which project? (${what})` },
    )
    return picked?.project
  }

  const storyOf = (node: PlatformNode | undefined): Story | undefined => (node?.kind === 'story' ? node.story : undefined)

  context.subscriptions.push(
    // ─── New story ───────────────────────────────────────────────────────────────────────────────
    vscode.commands.registerCommand('sdlcGovernance.platform.newStory', async (node?: PlatformNode) => {
      const project = await resolveProject(node, (p) => canIn(platform, p, 'story.create'), 'create stories')
      if (!project) return
      const title = await vscode.window.showInputBox({
        title: `New story in ${project.key} (1/4)`,
        prompt: 'Title — what should the user be able to do?',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length === 0 ? 'A story needs a title.' : v.trim().length > 200 ? 'At most 200 characters.' : undefined),
      })
      if (!title?.trim()) return
      const description = await vscode.window.showInputBox({
        title: `New story in ${project.key} (2/4)`,
        prompt: 'Description (optional) — you can add acceptance criteria and more detail in the story panel',
        ignoreFocusOut: true,
      })
      if (description === undefined) return
      const priority = await vscode.window.showQuickPick(
        STORY_PRIORITIES.map((p) => ({ label: PRIORITY_LABEL[p], priority: p, picked: p === 'medium' })),
        { title: `New story in ${project.key} (3/4) — priority`, ignoreFocusOut: true },
      )
      if (!priority) return
      const status = await vscode.window.showQuickPick(
        [
          { label: 'Draft', description: 'Still being written — not offered for pick-up', status: 'draft' as const },
          { label: 'Ready', description: 'Developers can pick it up now', status: 'ready' as const },
        ],
        { title: `New story in ${project.key} (4/4) — start as`, ignoreFocusOut: true },
      )
      if (!status) return
      const created = await withClient((c) =>
        c.createStory(project.key, { title: title.trim(), description: description.trim(), priority: priority.priority, status: status.status }),
      )
      if (!created) return
      refreshStories()
      const choice = await vscode.window.showInformationMessage(`Created ${created.key} · ${created.title}.`, 'Open Story', 'Open in Browser')
      if (choice === 'Open Story') await vscode.commands.executeCommand('sdlcGovernance.platform.openStory', { kind: 'story', story: created })
      if (choice === 'Open in Browser') platform.openInBrowser(`/projects/${created.projectKey}/stories/${created.number}`)
    }),

    // ─── Assign ──────────────────────────────────────────────────────────────────────────────────
    vscode.commands.registerCommand('sdlcGovernance.platform.assignStory', async (node?: PlatformNode) => {
      const story = storyOf(node)
      if (!story) return
      const detail = await withClient((c) => c.project(story.projectKey))
      if (!detail) return
      const meId = platform.me()?.user.id
      type Item = vscode.QuickPickItem & { userId?: string | null }
      const members = detail.members
        .filter((m) => m.role !== 'viewer')
        .sort((a, b) => Number(b.user.id === meId) - Number(a.user.id === meId) || a.user.displayName.localeCompare(b.user.displayName))
      const items: Item[] = [
        ...members.map(
          (m): Item => ({
            label: `${m.user.id === story.assignee?.id ? '$(check) ' : ''}${m.user.displayName}${m.user.id === meId ? ' (me)' : ''}`,
            description: PROJECT_ROLE_LABELS[m.role],
            detail: m.user.email,
            userId: m.user.id,
          }),
        ),
        ...(story.assignee ? [{ label: '', kind: vscode.QuickPickItemKind.Separator } as Item, { label: '$(circle-slash) Unassign', userId: null }] : []),
      ]
      const picked = await vscode.window.showQuickPick(items, { title: `Assign ${story.key}`, matchOnDetail: true })
      if (!picked || picked.userId === undefined || picked.userId === (story.assignee?.id ?? null)) return
      const updated = await withClient((c) => c.assignStory(story.projectKey, story.number, picked.userId ?? null))
      if (!updated) return
      refreshStories()
      void vscode.window.setStatusBarMessage(updated.assignee ? `${updated.key} → ${updated.assignee.displayName}` : `${updated.key} unassigned`, 3000)
    }),

    // ─── Project memory ──────────────────────────────────────────────────────────────────────────
    vscode.commands.registerCommand('sdlcGovernance.platform.addProjectMemory', async (node?: PlatformNode) => {
      const project = await resolveProject(node, (p) => canIn(platform, p, 'memory.curate'), 'add project memory')
      if (!project) return
      const kinds: MemoryKind[] = ['convention', 'decision', 'learning', 'note']
      const kind = await vscode.window.showQuickPick(
        kinds.map((k) => ({ label: MEMORY_KIND_LABELS[k], memoryKind: k })),
        { title: `Add to ${project.key} project memory — kind` },
      )
      if (!kind) return
      const title = await vscode.window.showInputBox({
        title: `${MEMORY_KIND_LABELS[kind.memoryKind]} for ${project.key}`,
        prompt: 'What should every agent and developer know?',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length > 200 ? 'At most 200 characters.' : undefined),
      })
      if (!title?.trim()) return
      const content = await vscode.window.showInputBox({
        title: `${MEMORY_KIND_LABELS[kind.memoryKind]} for ${project.key}`,
        prompt: 'Details — why, where, how (optional)',
        ignoreFocusOut: true,
      })
      if (content === undefined) return
      const pin = await vscode.window.showQuickPick(
        [
          { label: 'Don’t pin', description: 'Agents get it when it is relevant', pinned: false },
          { label: '$(pinned) Pin for every agent', description: 'Always included in agent context', pinned: true },
        ],
        { title: 'Pin it?' },
      )
      if (!pin) return
      const created = await withClient((c) =>
        c.addProjectMemory(project.key, { kind: kind.memoryKind, title: title.trim(), content: content.trim(), pinned: pin.pinned }),
      )
      if (!created) return
      refreshStories()
      void vscode.window.showInformationMessage(`Added “${created.title}” to ${project.key} project memory${created.pinned ? ', pinned' : ''}.`)
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.pinMemory', (node?: MemoryNode) => setPinned(node, true)),
    vscode.commands.registerCommand('sdlcGovernance.platform.unpinMemory', (node?: MemoryNode) => setPinned(node, false)),

    // ─── Linked repository ───────────────────────────────────────────────────────────────────────
    vscode.commands.registerCommand('sdlcGovernance.platform.cloneRepository', async (node?: PlatformNode) => {
      const project = await resolveProject(node, (p) => p.repository !== null, 'clone a linked repository')
      if (!project) return
      const detail = await withClient((c) => c.project(project.key))
      if (!detail) return
      const url = detail.repoUrl
      if (!url) {
        void vscode.window.showInformationMessage(`${project.key} has no linked repository. Link one on the project's Code page.`)
        return
      }
      const git = await getGitApi()
      const open = git?.repositories.find((r) => sameRepository(getOriginRemote(r)?.fetchUrl, url))
      if (open) {
        void vscode.window.showInformationMessage(`${project.repository?.displayName ?? url} is already open in this window (${open.rootUri.fsPath}).`)
        return
      }
      // The built-in Git clone flow: asks where to put it, then offers to open it.
      await vscode.commands.executeCommand('git.clone', url)
    }),
  )

  async function setPinned(node: MemoryNode | undefined, pinned: boolean): Promise<void> {
    if (node?.kind !== 'memoryItem') return
    const updated = await withClient((c) => c.updateMemory(node.project.key, node.item.id, { pinned }))
    if (!updated) return
    refreshStories()
    void vscode.window.setStatusBarMessage(pinned ? `Pinned “${updated.title}” for every agent` : `Unpinned “${updated.title}”`, 3000)
  }
}
