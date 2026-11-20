// Git commit/push + Azure DevOps PR-creation tools offered to the language model during an agent
// dispatch. Mirrors fileTools.ts / adoTools.ts: defs are passed *inline* per `model.sendRequest`,
// scoped to the @sdlc run that offers them, gated by toolGating.mapAgentToolsToGitTools. We own the
// implementations; failures are returned as readable *strings* — never thrown — so the model can
// read the error and recover.
//
// Safety-critical: git_commit_and_push stages ONLY the paths this run actually wrote (tracked via
// fileTools.ts's onWrite hook), never `git add -A` — an unrelated dirty file already sitting in the
// developer's working copy must never be silently swept into a pushed, PR'd branch. It also refuses
// outright to push directly to the configured target/default branch.

import * as vscode from 'vscode'
import type { Repository } from '../../@types/git'
import { createPullRequest, type PullRequest } from '../../integrations/azureDevOps/adoClient'

import { GIT_READ_TOOLS, GIT_WRITE_TOOLS, type GitToolName, type GitToolPermission } from './toolCatalog'

export {
  GIT_READ_TOOLS,
  GIT_WRITE_TOOLS,
  type GitReadTool,
  type GitToolName,
  type GitToolPermission,
  type GitWriteTool,
} from './toolCatalog'

/** Azure DevOps context for PR creation; omit to disable create_pull_request entirely. */
export interface GitAdoContext {
  org: string
  project: string
  repository: string
  getToken: () => Promise<string>
  workItemId?: number
}

/** Per-run git configuration the tools act against. */
export interface GitToolConfig {
  /** Resolve the workspace's git Repository fresh; undefined when none is detected. */
  getRepository: () => Promise<Repository | undefined>
  /** Workspace-relative paths this run's agent actually wrote (fileTools.ts's onWrite hook). */
  changedPaths: Set<string>
  /** Base branch for PRs; git_commit_and_push refuses to push directly to this branch. */
  targetBranch: string
  ado?: GitAdoContext
  createDraftPRs: boolean
}

type ToolInput = Record<string, unknown>

const TOOL_DEFS: Record<GitToolName, vscode.LanguageModelChatTool> = {
  git_status: {
    name: 'git_status',
    description: 'List files changed in the workspace git repository (working tree, staged, and untracked).',
    inputSchema: { type: 'object', properties: {} },
  },
  git_commit_and_push: {
    name: 'git_commit_and_push',
    description:
      'Commit and push the files written during this run to a NEW branch (never the target/default branch). ' +
      'Only stages files this agent actually wrote — never the whole working tree.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description: 'New branch name to create and push. Auto-generated if omitted. Must not be the target branch.',
        },
        message: { type: 'string', description: 'Commit message.' },
      },
      required: ['message'],
    },
  },
  create_pull_request: {
    name: 'create_pull_request',
    description: 'Open an Azure DevOps Pull Request from a pushed branch into the configured target branch.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Pull request title.' },
        description: { type: 'string', description: 'Pull request description.' },
        sourceBranch: {
          type: 'string',
          description: 'Branch to open the PR from. Defaults to the branch just pushed by git_commit_and_push in this run.',
        },
      },
      required: ['title'],
    },
  },
}

/** Reject git operations when the workspace isn't trusted (restricted mode). */
function ensurePushable(): string | undefined {
  if (!vscode.workspace.isTrusted) {
    return 'The workspace is not trusted; git operations are disabled. Trust the workspace to allow commits/pushes.'
  }
  return undefined
}

function autoBranchName(): string {
  return `sdlc/agent-${Date.now()}`
}

/**
 * Build the git tools to offer the model and an `invoke` that executes a call by name. Returns no
 * defs when `config` is undefined (no git repo detected for this run) or when permission grants
 * nothing. `lastPushedBranch` is closure state scoped to this one dispatch call, letting
 * create_pull_request default to the branch git_commit_and_push just pushed.
 */
export function buildGitTools(
  perm: GitToolPermission,
  config: GitToolConfig | undefined,
): {
  defs: vscode.LanguageModelChatTool[]
  invoke: (name: string, input: ToolInput, token: vscode.CancellationToken) => Promise<string>
} {
  const names: GitToolName[] = []
  if (config) {
    if (perm.read) names.push(...GIT_READ_TOOLS)
    for (const w of GIT_WRITE_TOOLS) if (perm.write.has(w)) names.push(w)
  }
  const defs = names.map((n) => TOOL_DEFS[n])

  let lastPushedBranch: string | undefined

  const invoke = async (name: string, input: ToolInput, _token: vscode.CancellationToken): Promise<string> => {
    if (!config) return 'No git repository is configured for this run; git/PR tools are unavailable.'
    if (!names.includes(name as GitToolName)) return `Tool "${name}" is not permitted for this agent.`

    try {
      switch (name as GitToolName) {
        case 'git_status': {
          const repo = await config.getRepository()
          if (!repo) return 'No git repository detected in this workspace.'
          await repo.status()
          const changes = [
            ...repo.state.workingTreeChanges,
            ...repo.state.indexChanges,
            ...(repo.state.untrackedChanges ?? []),
          ]
          if (changes.length === 0) return 'No changes in the working tree.'
          const paths = Array.from(new Set(changes.map((c) => vscode.workspace.asRelativePath(c.uri, false))))
          return paths.join('\n')
        }

        case 'git_commit_and_push': {
          const blocked = ensurePushable()
          if (blocked) return blocked
          const repo = await config.getRepository()
          if (!repo) return 'No git repository detected in this workspace; cannot commit.'
          const message = String(input.message ?? '').trim()
          if (!message) return 'The "message" argument is empty; a commit message is required.'
          const paths = Array.from(config.changedPaths)
          if (paths.length === 0) {
            return (
              'No files were written by this agent during this run; nothing to commit. ' +
              'git_commit_and_push only stages files written via write_file/replace_in_file in this run.'
            )
          }
          const branch = String(input.branch ?? '').trim() || autoBranchName()
          if (branch === config.targetBranch) {
            return `Refusing to push directly to "${config.targetBranch}" (the target branch). Supply a different branch name.`
          }
          // Repository.add() takes absolute filesystem paths, not workspace-relative ones — the
          // paths tracked from write_file/replace_in_file are relative, so resolve them here.
          const absolutePaths = paths.map((rel) => vscode.Uri.joinPath(repo.rootUri, rel).fsPath)
          await repo.createBranch(branch, true)
          await repo.add(absolutePaths)
          await repo.commit(message)
          await repo.push('origin', branch, true)
          lastPushedBranch = branch
          return `Pushed ${paths.length} file(s) to new branch "${branch}".`
        }

        case 'create_pull_request': {
          if (!config.ado) return 'Azure DevOps is not configured for this run; PR creation is unavailable.'
          const sourceBranch = String(input.sourceBranch ?? '').trim() || lastPushedBranch
          if (!sourceBranch) {
            return 'No branch to open a PR from — call git_commit_and_push first, or supply "sourceBranch".'
          }
          const title = String(input.title ?? '').trim()
          if (!title) return 'The "title" argument is empty; a PR title is required.'
          const token = await config.ado.getToken()
          const pr: PullRequest = await createPullRequest({
            org: config.ado.org,
            project: config.ado.project,
            token,
            repository: config.ado.repository,
            sourceBranch,
            targetBranch: config.targetBranch,
            title,
            description: input.description === undefined ? undefined : String(input.description),
            isDraft: config.createDraftPRs,
            workItemIds: config.ado.workItemId ? [config.ado.workItemId] : undefined,
          })
          return `Opened pull request #${pr.id}: ${pr.url}`
        }

        default:
          return `Unknown tool "${name}".`
      }
    } catch (e) {
      return `Tool "${name}" failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  return { defs, invoke }
}
