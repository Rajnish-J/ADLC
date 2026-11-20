// Working on a platform story from VS Code: the code-activity tracker (working state + commits), the run reporter
// (agent runs), the status-bar indicator, the Story panel, and the commands around them — create the story
// branch, link a branch to a story, add a note or the current selection to the story's memory.

import * as path from 'path'
import * as vscode from 'vscode'
import { MEMORY_KIND_LABELS, type MemoryKind, type PlatformEvent, type Story, type User } from '@sdlc/contracts'
import { getRepository } from '../integrations/git/gitRepository'
import type { AgentFileWrite } from '../runtime/dispatch/lmAgentDispatcher'
import type { RunService } from '../runtime/runService'
import type { CatalogNode } from './platformCatalogProviders'
import type { PlatformClient } from './platformClient'
import type { PlatformNode } from './platformStoriesProvider'
import { StoryPanel } from './storyPanel/storyPanel'
import { storyBranchName } from './storyFormat'
import { CodeActivityTracker, type TrackingState } from './work/codeActivityTracker'
import { RunReporter } from './work/runReporter'
import { storyFromKey, storyKeyOf, type StoryRef } from './work/storyRef'

const ACTIVE_STORY_KEY = 'sdlcGovernance.platform.hasActiveStory'
const SNIPPET_MAX = 2_000

export interface StoryWorkDeps {
  context: vscode.ExtensionContext
  runs: RunService
  onDidWriteFile?: vscode.Event<AgentFileWrite>
  client: () => PlatformClient | undefined
  me: () => User | undefined
  onPlatformEvent: vscode.Event<PlatformEvent>
  log: (message: string) => void
}

export interface StoryWork {
  tracker: CodeActivityTracker
  /** Connection or identity changed: re-check tracking and reload open story panels. */
  refresh(): void
}

/** A story argument from the tree, the Story panel, or a `{ projectKey, number }` reference. */
type StoryArg = PlatformNode | { kind: 'story'; story: Story } | StoryRef | undefined

function statusBarFor(item: vscode.StatusBarItem, state: TrackingState): void {
  if (state.kind === 'idle') {
    item.hide()
    return
  }
  const key = storyKeyOf(state.story)
  item.backgroundColor = undefined
  switch (state.kind) {
    case 'tracking':
      item.text = `$(pulse) ${key}`
      item.tooltip = `Reporting your work on ${key} · ${state.title}\n${state.files} file${state.files === 1 ? '' : 's'} changed — visible to your team in the SDLC platform.\nClick to open the story.`
      break
    case 'not-yours':
      item.text = `$(circle-slash) ${key}`
      item.tooltip = `${key} isn't assigned to you, so your work on this branch isn't reported.\nClick to open the story.`
      break
    case 'off':
      item.text = `$(debug-pause) ${key}`
      item.tooltip = 'Code activity tracking is off (sdlcGovernance.platform.trackCodeActivity).'
      break
    case 'offline':
      item.text = `$(warning) ${key}`
      item.tooltip = `Can't reach the SDLC platform: ${state.message}`
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
      break
    case 'unknown-story':
      item.text = `$(question) ${key}`
      item.tooltip = `This branch names ${key}, but the platform has no such story you can see. Use "Link This Branch to a Story" to fix it.`
      break
  }
  item.show()
}

export function registerStoryWork(deps: StoryWorkDeps): StoryWork {
  const { context } = deps
  const tracker = new CodeActivityTracker({ client: deps.client, workspaceState: context.workspaceState, log: deps.log })
  const reporter = new RunReporter({
    runs: deps.runs,
    onDidWriteFile: deps.onDidWriteFile,
    client: deps.client,
    activeStory: () => tracker.activeStory(),
    log: deps.log,
  })
  const statusBar = vscode.window.createStatusBarItem('sdlcGovernance.platform.story', vscode.StatusBarAlignment.Left, 50)
  statusBar.name = 'SDLC story'
  statusBar.command = 'sdlcGovernance.platform.openActiveStory'

  const panelDeps = {
    extensionUri: context.extensionUri,
    client: deps.client,
    me: deps.me,
    tracking: () => tracker.currentState(),
    onPlatformEvent: deps.onPlatformEvent,
    onTrackingChange: tracker.onDidChangeState,
    runStoryCommand: (command: string, story: Story) => vscode.commands.executeCommand(command, { kind: 'story', story }),
    log: deps.log,
  }

  const requireClient = (): PlatformClient | undefined => {
    const client = deps.client()
    if (!client) void vscode.window.showWarningMessage('Connect to the SDLC platform first.')
    return client
  }

  const fail = (err: unknown): undefined => {
    void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err))
    return undefined
  }

  /** The story an action targets: the argument, else the checked-out story branch, else one of yours. */
  const resolveStory = async (arg: StoryArg): Promise<Story | undefined> => {
    const client = requireClient()
    if (!client) return undefined
    try {
      if (arg && 'kind' in arg && arg.kind === 'story') return arg.story
      const ref = arg && 'projectKey' in arg ? arg : tracker.activeStory()
      if (ref) return await client.story(ref.projectKey, ref.number)
      const mine = await client.myStories()
      if (mine.length === 0) {
        void vscode.window.showInformationMessage('You have no stories assigned. Pick one up in the Platform Stories view.')
        return undefined
      }
      const picked = await vscode.window.showQuickPick(
        mine.map((s) => ({ label: s.key, description: s.title, story: s })),
        { title: 'Which story?', placeHolder: 'Your stories' },
      )
      return picked?.story
    } catch (err) {
      return fail(err)
    }
  }

  const pickKind = async (): Promise<MemoryKind | undefined> => {
    const kinds: MemoryKind[] = ['note', 'decision', 'convention', 'learning']
    const picked = await vscode.window.showQuickPick(
      kinds.map((k) => ({ label: MEMORY_KIND_LABELS[k], memoryKind: k })),
      { title: 'What kind of memory?' },
    )
    return picked?.memoryKind
  }

  context.subscriptions.push(
    tracker,
    reporter,
    statusBar,
    tracker.onDidChangeState((state) => {
      statusBarFor(statusBar, state)
      void vscode.commands.executeCommand('setContext', ACTIVE_STORY_KEY, state.kind !== 'idle')
    }),
    deps.onPlatformEvent((e) => {
      if (e.type === 'story.changed') tracker.storyChanged(e.projectKey, e.storyNumber)
      if (e.type === 'project.changed') tracker.refresh()
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.openStory', async (arg?: StoryArg | CatalogNode) => {
      if (!requireClient()) return
      // A run row in Workflows › Project runs opens the story it ran on.
      if (arg && 'kind' in arg && arg.kind === 'run') {
        if (arg.run.story) StoryPanel.show(panelDeps, arg.project.key, arg.run.story.number)
        return
      }
      const ref = arg && 'kind' in arg && arg.kind === 'story' ? { projectKey: arg.story.projectKey, number: arg.story.number } : arg && 'projectKey' in arg ? arg : undefined
      const story = ref ? undefined : await resolveStory(undefined)
      const target = ref ?? (story ? { projectKey: story.projectKey, number: story.number } : undefined)
      if (target) StoryPanel.show(panelDeps, target.projectKey, target.number)
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.openActiveStory', () => {
      const ref = tracker.activeStory()
      if (ref) StoryPanel.show(panelDeps, ref.projectKey, ref.number)
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.createBranch', async (arg?: StoryArg) => {
      const story = await resolveStory(arg)
      if (!story) return
      const repo = await getRepository()
      if (!repo) {
        void vscode.window.showWarningMessage('Open the story’s repository folder first.')
        return
      }
      const name = storyBranchName(story)
      try {
        if (repo.state.HEAD?.name === name) {
          void vscode.window.showInformationMessage(`You're already on ${name}.`)
          return
        }
        const exists = await repo.getBranch(name).then(
          () => true,
          () => false,
        )
        if (exists) await repo.checkout(name)
        else await repo.createBranch(name, true)
        void vscode.window.setStatusBarMessage(`$(git-branch) ${exists ? 'Switched to' : 'Created'} ${name} — your work on ${story.key} is now reported.`, 6000)
        tracker.refresh()
      } catch (err) {
        fail(err)
      }
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.linkBranch', async () => {
      const branch = tracker.currentBranch()
      if (!branch) {
        void vscode.window.showWarningMessage('No git branch is checked out in this workspace.')
        return
      }
      const current = tracker.branchLinks()[branch]
      const input = await vscode.window.showInputBox({
        title: `Link branch "${branch}" to a story`,
        prompt: 'Story key, e.g. PAY-2 (leave empty to remove the link)',
        value: current ?? '',
        validateInput: (v) => (!v.trim() || storyFromKey(v) ? undefined : 'Use the story key, e.g. PAY-2'),
      })
      if (input === undefined) return
      const ref = storyFromKey(input)
      await tracker.linkBranch(branch, ref ? storyKeyOf(ref) : undefined)
      void vscode.window.showInformationMessage(ref ? `Branch ${branch} is linked to ${storyKeyOf(ref)}.` : `Removed the story link from ${branch}.`)
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.addMemoryNote', async (arg?: StoryArg) => {
      const story = await resolveStory(arg)
      const client = deps.client()
      if (!story || !client) return
      if (!story.actions.canAddMemory) {
        void vscode.window.showWarningMessage(`You can't add to ${story.key}'s memory — it isn't assigned to you.`)
        return
      }
      const kind = await pickKind()
      if (!kind) return
      const title = await vscode.window.showInputBox({ title: `${MEMORY_KIND_LABELS[kind]} for ${story.key}`, prompt: 'What should be remembered?', ignoreFocusOut: true })
      if (!title?.trim()) return
      const content = await vscode.window.showInputBox({ title: `${MEMORY_KIND_LABELS[kind]} for ${story.key}`, prompt: 'Details — why, where, how (optional)', ignoreFocusOut: true })
      try {
        await client.addStoryMemory(story.projectKey, story.number, { kind, title: title.trim(), content: content?.trim() ?? '' })
        void vscode.window.showInformationMessage(`Added to ${story.key}'s memory.`)
      } catch (err) {
        fail(err)
      }
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.addSelectionToMemory', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      const story = await resolveStory(undefined)
      const client = deps.client()
      if (!story || !client) return
      if (!story.actions.canAddMemory) {
        void vscode.window.showWarningMessage(`You can't add to ${story.key}'s memory — it isn't assigned to you.`)
        return
      }
      const sel = editor.selection
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
      const rel = folder ? path.relative(folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join('/') : path.basename(editor.document.uri.fsPath)
      const text = editor.document.getText(sel.isEmpty ? editor.document.lineAt(sel.active.line).range : sel)
      const startLine = (sel.isEmpty ? sel.active.line : sel.start.line) + 1
      const endLine = sel.isEmpty ? startLine : sel.end.line + 1
      const kind = await pickKind()
      if (!kind) return
      const title = await vscode.window.showInputBox({
        title: `${MEMORY_KIND_LABELS[kind]} for ${story.key} — ${rel}:${startLine}`,
        prompt: 'What should be remembered about this code?',
        ignoreFocusOut: true,
      })
      if (!title?.trim()) return
      const snippet = text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}\n…` : text
      const content = `${rel}:${startLine}${endLine !== startLine ? `-${endLine}` : ''}\n\n\`\`\`${editor.document.languageId}\n${snippet}\n\`\`\``
      try {
        await client.addStoryMemory(story.projectKey, story.number, {
          kind,
          title: title.trim(),
          content,
          fileRefs: [{ path: rel, startLine, endLine }],
        })
        void vscode.window.showInformationMessage(`Added to ${story.key}'s memory.`)
      } catch (err) {
        fail(err)
      }
    }),
  )

  void tracker.start()

  return {
    tracker,
    refresh: () => {
      tracker.refresh()
      StoryPanel.refreshAll()
    },
  }
}
