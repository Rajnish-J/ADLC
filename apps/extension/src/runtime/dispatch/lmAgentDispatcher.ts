// Real agent dispatcher backed by the VS Code Language Model API (vscode.lm).
//
// Swaps in for StubAgentDispatcher behind the same AgentDispatcher port (src/runtime/port.ts), so the
// MockWorkflowRuntime drive loop is unchanged — it just gets real model output. The dispatcher resolves
// the node's agent (by id) to its discovered InternalAgent, uses the agent's `instructions` as the system
// prompt, sends the run's current message as the user turn, and concatenates the streamed response.
//
// The dispatcher instance is shared (created once, injected into the runtime). Context is per RUN, keyed by
// `AgentDispatchInput.runId`: the chat participant binds its run's context (model, token, live stream) with
// `bindRun()` before starting the run; any run nobody bound (canvas / command runs) gets one built by the
// default context factory on its first dispatch. Concurrent runs therefore never share a resolver, model,
// written-files set or fragment stream.

import * as vscode from 'vscode'
import type { InternalAgent } from '../../discovery/agentModel'
import type {
  AgentDispatcher,
  AgentDispatchInput,
  AgentDispatchResult,
  FragmentSource,
} from '../port'
import { buildFileTools } from './fileTools'
import { buildAdoTools, type AdoToolConfig } from './adoTools'
import { buildGitTools, type GitToolConfig } from './gitTools'
import { resolveDispatchTools } from './toolGating'
import { assembleAgentPrompt, summarizeToolCall } from './prompt'

export { assembleAgentPrompt, summarizeToolCall } from './prompt'

/** The per-run part of GitToolConfig; `changedPaths` is tracked internally across the whole run. */
export type GitRunConfig = Omit<GitToolConfig, 'changedPaths'>

/** Resolves a node's agentId to the discovered agent that supplies its system prompt + model hint. */
export type AgentResolver = (agentId: string) => InternalAgent | undefined

/** Per-run context: bound by the chat participant, or built by the default factory for other runs. */
export interface DispatchContext {
  /** Look up an agent's instructions/model by the node's agentId. */
  resolve: AgentResolver
  /** Streamed-token callback, for live chat rendering. Receives each text fragment as it arrives. */
  onFragment?: (agentName: string, fragment: string) => void
  /**
   * The language model to dispatch with. When the run is driven from a chat participant, this is the
   * request's already-authorized model (`ChatRequest.model`) — preferred because a standalone
   * `vscode.lm.selectChatModels` call can return empty/unauthorized outside a chat turn.
   */
  model?: vscode.LanguageModelChat
  /**
   * The chat handler's cancellation token, threaded through so a cancelled chat turn stops the
   * agentic tool loop and the underlying model request. Falls back to an internal source when absent.
   */
  token?: vscode.CancellationToken
  /**
   * Azure DevOps connection for this run. When present, board tools (read always; write gated by the
   * agent's declared tools + the workspace kill-switch) are offered to agents alongside the file tools.
   * Absent when the run wasn't seeded from an issue trigger or ADO isn't configured.
   */
  ado?: AdoToolConfig
  /**
   * Git repository + Azure DevOps PR context for this run. When present, git_status is offered
   * (read); git_commit_and_push/create_pull_request are additionally gated by the agent's declared
   * tools + the workspace kill-switch (sdlcGovernance.azureDevOps.allowAgentPRs). Absent when no git
   * repo is detected for the workspace.
   */
  git?: GitRunConfig
}

/** One file an agent wrote, attributed to the run and step that wrote it. */
export interface AgentFileWrite {
  runId: string
  stepId?: string
  /** Workspace-relative path. */
  path: string
}

/** Builds the context for a run nobody bound explicitly. Called once, on the run's first dispatch. */
export type DispatchContextFactory = (input: AgentDispatchInput) => Promise<DispatchContext | undefined>

/** Observes every streamed fragment, attributed to its run/step. */
export type FragmentObserver = (agentName: string, fragment: string, source: FragmentSource) => void

interface RunBinding {
  ctx: DispatchContext | undefined
  /**
   * Workspace-relative paths written via write_file/replace_in_file across every agent step of this run —
   * not per dispatch, since a later "ship" agent typically commits files an earlier "implement" agent wrote.
   */
  changedPaths: Set<string>
}

/** Hard ceiling on tool-call rounds per agent step; overridden by sdlcGovernance.dispatch.maxToolIterations. */
const DEFAULT_MAX_TOOL_ITERATIONS = 30

/** Cheap fallback token estimate (chars/4), matching the stub, when the model can't count. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export class LmAgentDispatcher implements AgentDispatcher {
  /** Per-run bindings — from bindRun(), or created on a run's first dispatch via the default factory. */
  private readonly runs = new Map<string, Promise<RunBinding>>()
  private defaultContext: DispatchContextFactory | undefined
  // Independent of any run's binding — lets a second consumer (LangGraphWorkflowRuntime's live per-node
  // introspection, src/runtime/langgraph/langGraphRuntime.ts) observe every fragment, attributed to its run.
  private readonly fragmentObservers = new Set<FragmentObserver>()

  private readonly _onDidWriteFile = new vscode.EventEmitter<AgentFileWrite>()
  /**
   * Fires for every file an agent step writes (write_file / replace_in_file), attributed to its run and step —
   * the SDLC platform records which files each step changed. The per-run set below is dropped when a run ends.
   */
  readonly onDidWriteFile = this._onDidWriteFile.event

  /** Family/vendor preference for model selection; defaults to Copilot's default model. */
  constructor(private readonly selector: vscode.LanguageModelChatSelector = { vendor: 'copilot' }) {}

  /**
   * Bind the context for one run before starting it (runs drive synchronously inside startRun). Returns a
   * disposable that releases it — call after the run settles.
   */
  bindRun(runId: string, ctx: DispatchContext): vscode.Disposable {
    const binding = Promise.resolve<RunBinding>({ ctx, changedPaths: new Set() })
    this.runs.set(runId, binding)
    return new vscode.Disposable(() => {
      if (this.runs.get(runId) === binding) this.runs.delete(runId)
    })
  }

  /** The factory that builds context for runs nobody bound (canvas / command runs). */
  setDefaultContext(factory: DispatchContextFactory | undefined): void {
    this.defaultContext = factory
  }

  /** Forget a finished run's binding. The extension calls this when a run reaches a terminal state. */
  releaseRun(runId: string): void {
    this.runs.delete(runId)
  }

  /** Observe streamed fragments from every run. Returns a disposable that removes the observer. */
  observeFragments(fn: FragmentObserver): vscode.Disposable {
    this.fragmentObservers.add(fn)
    return new vscode.Disposable(() => this.fragmentObservers.delete(fn))
  }

  private emitFragment(binding: RunBinding, input: AgentDispatchInput, fragment: string): void {
    binding.ctx?.onFragment?.(input.agentName, fragment)
    const source: FragmentSource = { runId: input.runId, stepId: input.stepId }
    for (const fn of this.fragmentObservers) fn(input.agentName, fragment, source)
  }

  /** The run's binding — the bound one, else one built once (and cached for the run) by the default factory. */
  private bindingFor(input: AgentDispatchInput): Promise<RunBinding> {
    const existing = input.runId ? this.runs.get(input.runId) : undefined
    if (existing) return existing
    const created = (async (): Promise<RunBinding> => {
      let ctx: DispatchContext | undefined
      try {
        ctx = await this.defaultContext?.(input)
      } catch {
        ctx = undefined // dispatch still proceeds; an unresolved agent gets read-only tools
      }
      return { ctx, changedPaths: new Set() }
    })()
    if (input.runId) this.runs.set(input.runId, created)
    return created
  }

  async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
    const binding = await this.bindingFor(input)
    const ctx = binding.ctx
    const agent = ctx?.resolve(input.agentId)
    const systemInstructions = agent?.instructions?.trim() || ''

    // Prefer the chat request's authorized model; only fall back to selectChatModels when running
    // outside a chat turn (e.g. the Runs view).
    const model = ctx?.model ?? (await this.selectModel(agent?.model))
    if (!model) {
      throw new Error(
        'No language model is available. Open the workflow from Copilot Chat (it supplies the model), ' +
          'ensure GitHub Copilot Chat is installed, signed in and enabled, ' +
          'or set sdlcGovernance.dispatch.mode to "mock".',
      )
    }

    // The LM API has no dedicated system role; we fold the agent instructions, the persistent work
    // item, and the prior step's handoff into one framed user turn — the established pattern for
    // vscode.lm. Keeping the work item here (not just on the first agent) is what stops downstream
    // agents from groping through files and asking for it.
    const planOnly = input.phase === 'plan'
    const userContent = assembleAgentPrompt({
      instructions: systemInstructions,
      workItem: input.workItem,
      workItemId: input.workItemId,
      workItemUrl: input.workItemUrl,
      prior: input.prompt,
      planOnly,
      approvedPlan: input.approvedPlan,
    })
    const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(userContent)]

    // Offer only the tools this dispatch is permitted (governance gate, see resolveDispatchTools): the
    // agent's declared tools, never write tools for an agent we couldn't resolve, and read-only tools for
    // a planning turn. Board writes and commit/PR are further gated by their workspace kill-switches
    // (sdlcGovernance.azureDevOps.allowAgentWrites / allowAgentPRs). Tool names don't collide across the
    // bundles, so we can merge + route by name.
    const cfg = vscode.workspace.getConfiguration('sdlcGovernance')
    const perms = resolveDispatchTools({
      agentTools: agent?.tools,
      resolved: agent !== undefined,
      phase: input.phase,
      allowAdoWrites: cfg.get<boolean>('azureDevOps.allowAgentWrites', false),
      allowPRs: cfg.get<boolean>('azureDevOps.allowAgentPRs', false),
    })
    const fileBundle = buildFileTools(perms.file, (rel) => {
      binding.changedPaths.add(rel)
      if (input.runId) this._onDidWriteFile.fire({ runId: input.runId, stepId: input.stepId, path: rel })
    })
    const adoBundle = buildAdoTools(perms.ado, ctx?.ado)
    const gitConfig: GitToolConfig | undefined = ctx?.git ? { ...ctx.git, changedPaths: binding.changedPaths } : undefined
    const gitBundle = buildGitTools(perms.git, gitConfig)

    const bundles = [fileBundle, adoBundle, gitBundle]
    const tools = bundles.flatMap((b) => b.defs)
    const invokeByName = new Map(bundles.flatMap((b) => b.defs.map((d) => [d.name, b.invoke] as const)))
    const invoke = (name: string, callInput: Record<string, unknown>, tok: vscode.CancellationToken): Promise<string> =>
      (invokeByName.get(name) ?? fileBundle.invoke)(name, callInput, tok)

    // One internal cancellation source, fed by BOTH the chat handler's token (when bound) and the run's abort
    // signal (cancelRun), so either can stop an in-flight model request / tool loop. With neither present it
    // behaves exactly as before.
    const cts = new vscode.CancellationTokenSource()
    const token = cts.token
    const links: vscode.Disposable[] = []
    const chatToken = ctx?.token
    if (chatToken) {
      if (chatToken.isCancellationRequested) cts.cancel()
      else links.push(chatToken.onCancellationRequested(() => cts.cancel()))
    }
    const onAbort = (): void => cts.cancel()
    if (input.signal) {
      if (input.signal.aborted) cts.cancel()
      else input.signal.addEventListener('abort', onAbort, { once: true })
    }

    let response = ''
    let toolsDisabled = tools.length === 0
    try {
      for (let iter = 0; iter < this.maxToolIterations(); iter++) {
        if (token.isCancellationRequested) break

        const options: vscode.LanguageModelChatRequestOptions = toolsDisabled
          ? {}
          : { tools, toolMode: vscode.LanguageModelChatToolMode.Auto }

        let chat: vscode.LanguageModelChatResponse
        try {
          chat = await model.sendRequest(messages, options, token)
        } catch (e) {
          // Some Copilot models reject tool-calling; degrade once to text-only and retry.
          if (!toolsDisabled && e instanceof vscode.LanguageModelError) {
            toolsDisabled = true
            const note = '\n\n_(model declined tool use; continuing without code-editing tools)_\n'
            response += note
            this.emitFragment(binding, input, note)
            continue
          }
          throw e
        }

        const textParts: vscode.LanguageModelTextPart[] = []
        const toolCalls: vscode.LanguageModelToolCallPart[] = []
        for await (const part of chat.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            textParts.push(part)
            response += part.value
            this.emitFragment(binding, input, part.value)
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push(part)
            const marker = `\n\n_↳ ${summarizeToolCall(part)}_\n`
            response += marker
            this.emitFragment(binding, input, marker)
          }
        }

        // No tool calls this round → the agent is done.
        if (toolCalls.length === 0) break

        // Record the assistant turn (text + the calls it made), then feed back tool results.
        messages.push(vscode.LanguageModelChatMessage.Assistant([...textParts, ...toolCalls]))
        const resultParts: vscode.LanguageModelToolResultPart[] = []
        for (const call of toolCalls) {
          if (token.isCancellationRequested) break
          const result = await invoke(call.name, (call.input ?? {}) as Record<string, unknown>, token)
          resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(result)]))
        }
        messages.push(vscode.LanguageModelChatMessage.User(resultParts))
      }
    } finally {
      for (const link of links) link.dispose()
      input.signal?.removeEventListener('abort', onAbort)
      cts.dispose()
    }

    return {
      response,
      tokensIn: await this.count(model, userContent),
      tokensOut: await this.count(model, response),
    }
  }

  private maxToolIterations(): number {
    const cfg = vscode.workspace
      .getConfiguration('sdlcGovernance')
      .get<number>('dispatch.maxToolIterations', DEFAULT_MAX_TOOL_ITERATIONS)
    return Number.isFinite(cfg) && cfg > 0 ? Math.floor(cfg) : DEFAULT_MAX_TOOL_ITERATIONS
  }

  /**
   * Prefer a model whose family matches the agent's `model` hint, then the configured vendor
   * (Copilot), then ANY available vscode.lm model — so a governed run can use a non-Copilot provider
   * if one is registered, rather than failing outright.
   */
  private async selectModel(modelHint?: string): Promise<vscode.LanguageModelChat | undefined> {
    if (modelHint) {
      const hint = modelHint.toLowerCase()
      const family = hint.includes('gpt-4o') ? 'gpt-4o' : hint.includes('o1') ? 'o1' : undefined
      if (family) {
        const matched = await vscode.lm.selectChatModels({ ...this.selector, family })
        if (matched.length > 0) return matched[0]
      }
    }
    const preferred = await vscode.lm.selectChatModels(this.selector)
    if (preferred.length > 0) return preferred[0]
    // Last resort: any model the environment exposes (no selector matches all providers).
    const any = await vscode.lm.selectChatModels()
    return any[0]
  }

  private async count(model: vscode.LanguageModelChat, text: string): Promise<number> {
    try {
      return await model.countTokens(text)
    } catch {
      return estimateTokens(text)
    }
  }
}
