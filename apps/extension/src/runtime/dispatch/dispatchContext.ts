// Builds the per-run DispatchContext the LM dispatcher needs: an agent resolver (discovery + Foundry), the
// workspace's git/PR context and the Azure Boards connection. Shared by the @sdlc chat participant (which adds
// its chat model, cancellation token and live stream on top) and by the dispatcher's default context for runs
// started from the canvas or a command — which previously dispatched with no context at all, so their agents
// ran without instructions and were offered every tool.

import * as vscode from 'vscode'
import { ADO_SCOPE, ARM_SCOPE } from '../../foundry/constants'
import { getToken, isSignedIn } from '../../auth/azureAuth'
import { listFoundryAgents, toInternalAgentLike } from '../../foundry/foundryAgents'
import { discover } from '../../discovery/normalizer'
import type { InternalAgent } from '../../discovery/agentModel'
import { lookupPlatformAgent } from '../../platform/platformAgentRegistry'
import { lookupBuiltinAgent } from '../builtinAgentRegistry'
import { getRepository, getOriginRemote, parseAzureGitRemote } from '../../integrations/git/gitRepository'
import type { AgentDispatchInput } from '../port'
import type { AdoToolConfig } from './adoTools'
import type { AgentResolver, DispatchContext, GitRunConfig } from './lmAgentDispatcher'

/**
 * Resolve agent ids to discovered agents, plus Foundry agents (which run through vscode.lm too — only their
 * instructions/model hint come from Foundry). `foundry: 'if-signed-in'` skips Foundry when no Azure session
 * exists yet, so a run never pops a sign-in prompt mid-flight; `'always'` may prompt (the chat flow).
 */
export async function buildAgentResolver(opts: {
  token?: vscode.CancellationToken
  foundry: 'always' | 'if-signed-in'
}): Promise<AgentResolver> {
  const result = await discover(opts.token)
  const byId = new Map<string, InternalAgent>(result.agents.map((a) => [a.id, a]))
  if (opts.foundry === 'always' || (await isSignedIn(ARM_SCOPE))) {
    for (const fa of await listFoundryAgents(getToken)) {
      byId.set(fa.id, toInternalAgentLike(fa))
    }
  }
  // Project workflows from the SDLC platform bind platform agents by slug (registered before such a run starts);
  // the default "Story delivery" binds the built-ins by the same slugs, bundled for offline runs.
  return (id) => byId.get(id) ?? lookupPlatformAgent(id) ?? lookupBuiltinAgent(id)
}

/** Azure DevOps org/project from settings, else parsed from the workspace's `origin` remote. */
async function resolveAdoCoordinates(): Promise<{ org: string; project: string; repository: string } | undefined> {
  const cfg = vscode.workspace.getConfiguration('sdlcGovernance')
  const repo = await getRepository()
  const remote = repo ? getOriginRemote(repo) : undefined
  const parsed = parseAzureGitRemote(remote?.fetchUrl ?? remote?.pushUrl)
  const org = cfg.get<string>('azureDevOps.organization')?.trim() || parsed?.org || ''
  const project = cfg.get<string>('azureDevOps.project')?.trim() || parsed?.project || ''
  const repository = cfg.get<string>('azureDevOps.repository')?.trim() || parsed?.repo || ''
  return org && project ? { org, project, repository } : undefined
}

/**
 * Resolve the git repository + Azure DevOps PR context for a run. Returns undefined when no git repo is
 * detected — git_status/git_commit_and_push/create_pull_request are then simply not offered (see
 * lmAgentDispatcher.ts / gitTools.ts). Org/project/repository are auto-detected from the workspace's
 * 'origin' remote URL, with the sdlcGovernance.azureDevOps.* settings as an override — PR creation is
 * unavailable (though commit/push still works) if neither source resolves them.
 */
export async function resolveGitContext(workItemId: number | undefined): Promise<GitRunConfig | undefined> {
  const repo = await getRepository()
  if (!repo) return undefined

  const cfg = vscode.workspace.getConfiguration('sdlcGovernance')
  const targetBranch = cfg.get<string>('azureDevOps.targetBranch')?.trim() || 'main'
  const createDraftPRs = cfg.get<boolean>('azureDevOps.createDraftPRs', true)

  const coords = await resolveAdoCoordinates()
  const ado =
    coords && coords.repository
      ? { ...coords, getToken: () => getToken(ADO_SCOPE), workItemId }
      : undefined

  return {
    getRepository: async () => repo,
    targetBranch,
    createDraftPRs,
    ado,
  }
}

/** Azure Boards connection for a run seeded from a work item, when org/project resolve. */
export async function resolveAdoContext(workItemId: number | undefined): Promise<AdoToolConfig | undefined> {
  if (workItemId === undefined) return undefined
  const coords = await resolveAdoCoordinates()
  return coords ? { org: coords.org, project: coords.project, getToken: () => getToken(ADO_SCOPE), workItemId } : undefined
}

/**
 * Default context for a run nobody bound (canvas / command runs): resolve agents (Foundry only if already
 * signed in), and connect git + Azure Boards from the workspace. No chat model or token — the dispatcher
 * selects a model itself and the run's own abort signal handles cancellation.
 */
export async function buildDefaultDispatchContext(input: AgentDispatchInput): Promise<DispatchContext> {
  const [resolve, git, ado] = await Promise.all([
    buildAgentResolver({ foundry: 'if-signed-in' }),
    resolveGitContext(input.workItemId),
    resolveAdoContext(input.workItemId),
  ])
  return { resolve, git, ado }
}
