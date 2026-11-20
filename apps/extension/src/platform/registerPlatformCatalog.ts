// Commands behind the platform rows of the Agents, Workflows and Stories views: read an agent's instructions,
// switch it on or off for the project, change which agent a workflow step runs, and read / accept / reject /
// archive project memory. The API enforces every permission; the tree only hides what the user can't do.

import * as vscode from 'vscode'
import { MEMORY_KIND_LABELS, PROJECT_ROLE_LABELS } from '@sdlc/contracts'
import type { CatalogNode, PlatformAgentsProvider, PlatformRunsProvider, PlatformWorkflowsProvider } from './platformCatalogProviders'
import type { PlatformClient } from './platformClient'
import type { PlatformHandle } from './platformHandle'
import type { PlatformNode } from './platformStoriesProvider'
import { showReadonlyMarkdown } from './readonlyDocs'
import { providePlatform } from './platformAccess'
import { syncMyStories } from './boardsClient'
import { WorkflowCanvasPanel } from '../webview/workflowCanvasPanel'

export interface CatalogDeps {
  platform: PlatformHandle
  agents: PlatformAgentsProvider
  workflows: PlatformWorkflowsProvider
  runs: PlatformRunsProvider
}

type MemoryNode = Extract<PlatformNode, { kind: 'memoryItem' }>
type ProfileNode = Extract<PlatformNode, { kind: 'profile' }>

/** Virtual documents for diffing a proposed profile against the accepted one (vscode.diff needs two URIs). */
const PROFILE_SCHEME = 'sdlc-profile'
const profileDocs = new Map<string, string>()

export function registerPlatformCatalog(context: vscode.ExtensionContext, deps: CatalogDeps): void {
  const { platform } = deps
  // The workflow canvas and the run commands reach the platform through this (they are wired up apart from it).
  providePlatform(platform)

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

  const refreshCatalog = (): void => {
    deps.agents.refresh()
    deps.workflows.refresh()
    deps.runs.refresh()
  }

  const setEnabled = async (node: CatalogNode | undefined, enabled: boolean): Promise<void> => {
    if (node?.kind !== 'agent') return
    const ok = await withClient((c) => c.setAgentEnabled(node.project.key, node.agent.slug, enabled))
    if (ok === undefined) return
    refreshCatalog()
    void vscode.window.setStatusBarMessage(`${node.agent.name} ${enabled ? 'enabled' : 'disabled'} for ${node.project.key}`, 3000)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('sdlcGovernance.platform.openAgent', async (node?: CatalogNode) => {
      if (node?.kind !== 'agent') return
      const detail = await withClient((c) => c.agent(node.project.key, node.agent.slug))
      if (!detail) return
      const lines = [
        `# ${detail.name}`,
        '',
        `> ${detail.description}`,
        '',
        `- **Source:** ${detail.source === 'builtin' ? 'Built-in' : detail.source === 'platform' ? 'Platform (created in Chat)' : `Codebase${detail.branch ? ` (${detail.branch})` : ''}`}${detail.sourcePath ? ` — \`${detail.sourcePath}\`` : ''}`,
        `- **Stage:** ${detail.sdlcStage} · **Runs:** ${detail.executionTarget === 'local' ? 'in VS Code' : 'on the server'}`,
        `- **Enabled in ${node.project.key}:** ${detail.enabled ? 'yes' : 'no'}`,
        detail.requiredRole ? `- **Requires:** ${PROJECT_ROLE_LABELS[detail.requiredRole]} or above${detail.usable ? '' : ' (locked for you)'}` : '',
        detail.tools.length ? `- **Tools:** ${detail.tools.map((t) => `\`${t}\``).join(', ')}` : '',
        node.usedIn.length ? `- **Used in:** ${node.usedIn.join(', ')}` : '- **Used in:** no workflow step yet',
        '',
        '---',
        '',
        detail.instructions,
      ]
      await showReadonlyMarkdown(`${node.project.key}/agents/${detail.slug}.md`, lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n'))
    }),

    // Pull what is assigned to me in Azure Boards into stories now (every linked project), and say what changed.
    vscode.commands.registerCommand('sdlcGovernance.platform.syncAzureBoards', async () => {
      const res = await withClient(async (c) =>
        vscode.window.withProgress({ location: { viewId: 'sdlcGovernance.platformStories' }, title: 'Syncing from Azure DevOps…' }, () => syncMyStories(c, true)),
      )
      if (!res) return
      void vscode.commands.executeCommand('sdlcGovernance.platform.refresh')
      if (res.results.length === 0) {
        void vscode.window.showInformationMessage(
          'None of your projects is linked to Azure Boards yet. A project owner links it in the project’s settings on the web (linked Azure Repos projects are detected automatically).',
        )
        return
      }
      for (const r of res.results.filter((x) => x.error)) void vscode.window.showWarningMessage(`${r.projectKey}: ${r.error}`)
      const ok = res.results.filter((x) => !x.error)
      if (ok.length) {
        const created = ok.reduce((n, r) => n + r.created, 0)
        const updated = ok.reduce((n, r) => n + r.updated, 0)
        const found = ok.reduce((n, r) => n + r.found, 0)
        void vscode.window.showInformationMessage(
          `Azure DevOps: ${found} work item${found === 1 ? '' : 's'} assigned to you — ${created} new stor${created === 1 ? 'y' : 'ies'}, ${updated} updated.`,
        )
      }
    }),

    // A story synced from Azure Boards: open its work item.
    vscode.commands.registerCommand('sdlcGovernance.platform.openInAzureDevOps', async (node?: PlatformNode) => {
      const story = node?.kind === 'story' ? node.story : undefined
      if (story?.external) await vscode.env.openExternal(vscode.Uri.parse(story.external.url))
    }),

    // A project workflow in the canvas, with its step → agent mapping (Workflows view click, or a step's menu).
    vscode.commands.registerCommand('sdlcGovernance.platform.openWorkflow', async (node?: CatalogNode) => {
      if (node?.kind !== 'workflow' && node?.kind !== 'step') return
      await WorkflowCanvasPanel.renderPlatform(node.project.key, node.workflow.id)
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.enableAgent', (node?: CatalogNode) => setEnabled(node, true)),
    vscode.commands.registerCommand('sdlcGovernance.platform.disableAgent', (node?: CatalogNode) => setEnabled(node, false)),

    vscode.commands.registerCommand('sdlcGovernance.platform.changeStepAgent', async (node?: CatalogNode) => {
      if (node?.kind !== 'step' || node.node.kind !== 'agent') return
      const { project, workflow, node: step } = node
      const agents = await withClient((c) => c.agents(project.key))
      if (!agents) return
      const current = step.data.agentId
      type Item = vscode.QuickPickItem & { slug: string | null }
      const usable = agents.filter((a) => a.kind === 'agent' && a.enabled && a.usable)
      const items: Item[] = [
        ...usable.map(
          (a): Item => ({
            label: a.slug === current ? `$(check) ${a.name}` : a.name,
            description: [a.sdlcStage, a.source === 'repo' ? 'codebase' : a.source === 'platform' ? 'platform' : undefined].filter(Boolean).join(' · '),
            detail: a.description,
            slug: a.slug,
          }),
        ),
        { label: '$(circle-slash) No agent', description: 'Leave this step unassigned', slug: null },
      ]
      if (usable.length === 0) {
        void vscode.window.showInformationMessage(`No agents are enabled in ${project.key} that you can use. Enable one in the Agents view first.`)
        return
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: `${workflow.name} › ${step.label}`,
        placeHolder: 'Which agent runs this step? (only agents enabled for the project are offered)',
        matchOnDescription: true,
        matchOnDetail: true,
      })
      if (!picked || picked.slug === (current ?? null)) return
      const res = await withClient((c) => c.setStepAgent(project.key, workflow.id, step.id, picked.slug))
      if (!res) return
      refreshCatalog()
      void vscode.window.setStatusBarMessage(res.agentName ? `${step.label} now runs ${res.agentName}` : `${step.label} has no agent`, 3000)
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.openMemoryItem', async (node?: MemoryNode) => {
      if (node?.kind !== 'memoryItem') return
      const m = node.item
      const meta = [
        MEMORY_KIND_LABELS[m.kind],
        m.status,
        m.pinned ? 'pinned' : undefined,
        m.storyKey ? `from ${m.storyKey}${m.storyTitle ? ` — ${m.storyTitle}` : ''}` : undefined,
        m.author ? `by ${m.author.displayName}` : undefined,
      ].filter(Boolean)
      const refs = m.fileRefs.map((f) => `- \`${f.path}${f.startLine ? `:${f.startLine}${f.endLine ? `-${f.endLine}` : ''}` : ''}\``)
      const body = [`# ${m.title}`, '', `_${meta.join(' · ')}_`, '', m.content || '_No details._', ...(refs.length ? ['', '**Files**', '', ...refs] : [])]
      if (m.tags.length) body.push('', m.tags.map((t) => `\`#${t}\``).join(' '))
      await showReadonlyMarkdown(`${node.project.key}/memory/${m.id}.md`, body.join('\n'))
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.acceptMemory', async (node?: MemoryNode) => {
      if (node?.kind !== 'memoryItem') return
      if (await withClient((c) => c.decideMemory(node.project.key, node.item.id, true))) {
        void vscode.commands.executeCommand('sdlcGovernance.platform.refresh')
      }
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.rejectMemory', async (node?: MemoryNode) => {
      if (node?.kind !== 'memoryItem') return
      const comment = await vscode.window.showInputBox({ title: `Reject “${node.item.title}”`, prompt: 'Why? (optional — shown to the author)' })
      if (comment === undefined) return
      if (await withClient((c) => c.decideMemory(node.project.key, node.item.id, false, comment.trim() || undefined))) {
        void vscode.commands.executeCommand('sdlcGovernance.platform.refresh')
      }
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.archiveMemory', async (node?: MemoryNode) => {
      if (node?.kind !== 'memoryItem') return
      const ok = await vscode.window.showWarningMessage(
        `Archive “${node.item.title}”? Agents stop getting it as context.`,
        { modal: true },
        'Archive',
      )
      if (ok !== 'Archive') return
      if (await withClient((c) => c.archiveMemory(node.project.key, node.item.id))) {
        void vscode.commands.executeCommand('sdlcGovernance.platform.refresh')
      }
    }),

    // ─── Project profile (written by the built-in Project profiler; same as the web Memory page) ───

    vscode.workspace.registerTextDocumentContentProvider(PROFILE_SCHEME, {
      provideTextDocumentContent: (uri) => profileDocs.get(uri.path) ?? '',
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.openProjectProfile', async (node?: ProfileNode) => {
      if (node?.kind !== 'profile') return
      const { current, pending } = node.state
      const shown = current?.content ? current : pending
      if (!shown?.content) {
        void vscode.window.showInformationMessage(`${node.project.key} has no project profile yet.`)
        return
      }
      const note =
        pending?.status === 'proposed'
          ? `> An update from ${pending.runIds.length} run(s) is waiting for review — use “Compare Profile Update”.\n\n`
          : ''
      await showReadonlyMarkdown(`${node.project.key}/project-profile-v${shown.version}.md`, `${note}${shown.markdown}`)
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.generateProjectProfile', async (node?: ProfileNode) => {
      if (node?.kind !== 'profile') return
      const key = node.project.key
      const branches = await withClient((c) => c.repoBranches(key))
      if (!branches?.length) {
        if (branches) void vscode.window.showWarningMessage('The linked repository has no branches yet.')
        return
      }
      const sorted = [...branches].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
      const picked = await vscode.window.showQuickPick(
        sorted.map((b) => ({
          label: b.name,
          description: [b.isDefault ? 'default' : undefined, b.indexedSha ? `${b.fileCount} files` : 'not loaded yet'].filter(Boolean).join(' · '),
          detail: b.commit?.message.split('\n')[0],
          branch: b,
        })),
        { title: `${node.state.current ? 'Regenerate' : 'Generate'} the ${key} project profile`, placeHolder: 'Branch the Project profiler reads' },
      )
      if (!picked) return
      if (!picked.branch.indexedSha) {
        // The platform loads the branch's files first; generate once they are in.
        await withClient((c) => c.openRepoBranch(key, picked.branch.name))
        const ready = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Loading ${picked.branch.name} on the platform…` },
          async () => {
            for (let i = 0; i < 60; i++) {
              await new Promise((r) => setTimeout(r, 2_000))
              const now = await platform.client()?.repoBranches(key).catch(() => undefined)
              if (now?.find((b) => b.name === picked.branch.name)?.indexedSha) return true
            }
            return false
          },
        )
        if (!ready) {
          void vscode.window.showWarningMessage(`${picked.branch.name} is still loading on the platform — try again in a moment.`)
          return
        }
      }
      if (await withClient((c) => c.generateProjectProfile(key, picked.branch.name))) {
        void vscode.window.showInformationMessage(`The Project profiler is reading ${picked.branch.name}. The profile appears under Project memory when it is written.`)
        void vscode.commands.executeCommand('sdlcGovernance.platform.refresh')
      }
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.diffProjectProfile', async (node?: ProfileNode) => {
      if (node?.kind !== 'profile' || node.state.pending?.status !== 'proposed') return
      const { current, pending } = node.state
      const left = `/${node.project.key}/profile-v${current?.version ?? 0}.md`
      const right = `/${node.project.key}/profile-v${pending.version}-proposed.md`
      profileDocs.set(left, current?.markdown ?? '')
      profileDocs.set(right, pending.markdown)
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.from({ scheme: PROFILE_SCHEME, path: left }),
        vscode.Uri.from({ scheme: PROFILE_SCHEME, path: right }),
        `${node.project.key} profile: v${current?.version ?? 0} ↔ proposed v${pending.version}`,
      )
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.acceptProjectProfile', async (node?: ProfileNode) => {
      const pending = node?.kind === 'profile' ? node.state.pending : null
      if (!node || pending?.status !== 'proposed') return
      if (await withClient((c) => c.decideProjectProfile(node.project.key, pending.id, 'accept'))) {
        void vscode.window.setStatusBarMessage(`${node.project.key} project profile updated to v${pending.version}`, 3000)
        void vscode.commands.executeCommand('sdlcGovernance.platform.refresh')
      }
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.rejectProjectProfile', async (node?: ProfileNode) => {
      const pending = node?.kind === 'profile' ? node.state.pending : null
      if (!node || pending?.status !== 'proposed') return
      const comment = await vscode.window.showInputBox({ title: `Reject the ${node.project.key} profile update`, prompt: 'Why? (optional)' })
      if (comment === undefined) return
      if (await withClient((c) => c.decideProjectProfile(node.project.key, pending.id, 'reject', comment.trim() || undefined))) {
        void vscode.commands.executeCommand('sdlcGovernance.platform.refresh')
      }
    }),

    vscode.commands.registerCommand('sdlcGovernance.platform.refreshCatalog', refreshCatalog),
  )
}
