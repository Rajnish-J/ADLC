// Per-agent governance command.
//
// Assesses user-supplied content against a chosen set of governance criteria (PII, prompt-injection,
// toxicity, policy adherence, custom regex) and records one synthetic AuditRecord per criterion so
// the verdict surfaces in the Evaluation Results tab under a "Governance" group. PII routes through
// Purview when enabled (heuristic fallback otherwise); every other criterion is a local heuristic.
// Triggered from the Discovered Agents tree (⛨ button) and the Workflow Canvas.

import * as vscode from 'vscode'
import * as crypto from 'crypto'
import { getToken } from '../auth/azureAuth'
import { discover } from '../discovery/normalizer'
import type { InternalAgent } from '../discovery/agentModel'
import { classifyContent } from '../foundry/purview'
import { readPurviewConfig } from '../eval/settings'
import {
  CRITERION_IDS,
  promptInjectionChecker,
  toxicityChecker,
  makePolicyChecker,
  makeCustomRegexChecker,
  type CriterionChecker,
  type CriterionResult,
} from '../eval/criteria'
import type { AuditRecord } from '../audit/auditRecord'
import type { AuditStore } from '../audit/auditStore'
import type { EvaluationResultsProvider } from '../views/evaluationResultsProvider'
import type { EvalLog } from '../telemetry/evalOutputChannel'

export interface GovernAgentDeps {
  store: AuditStore
  results: EvaluationResultsProvider
  channel: EvalLog
}

/** Resolve agent from tree-view item, raw InternalAgent, or agentId string. */
async function resolveAgent(arg: unknown): Promise<InternalAgent | undefined> {
  if (!arg) return undefined

  if (typeof arg === 'object' && 'agent' in (arg as object)) {
    return (arg as { agent: InternalAgent }).agent
  }
  if (typeof arg === 'object' && 'id' in (arg as object) && 'name' in (arg as object)) {
    return arg as InternalAgent
  }
  if (typeof arg === 'string') {
    const { agents } = await discover()
    const found = agents.find((a) => a.id === arg)
    if (!found) {
      void vscode.window.showWarningMessage(
        `Agent "${arg}" not found in workspace. Run Discover first.`,
      )
    }
    return found
  }
  return undefined
}

interface CriterionPick {
  label: string
  id: string
  picked?: boolean
}

/**
 * Step 2 of the wizard: choose which criteria to enforce. Loops until at least one
 * is selected or the user cancels. PII / policy / custom-regex that need extra input
 * are gathered here, producing the concrete CriterionChecker list to run.
 */
async function collectCriteria(
  content: string,
): Promise<CriterionChecker[] | undefined> {
  const items: CriterionPick[] = [
    { label: 'PII detection', id: CRITERION_IDS.pii },
    { label: 'Prompt injection risk', id: CRITERION_IDS.promptInjection },
    { label: 'Toxicity / harmful language', id: CRITERION_IDS.toxicity },
    { label: 'Policy adherence', id: CRITERION_IDS.policyAdherence },
    { label: 'Custom regex', id: CRITERION_IDS.customRegex },
  ]

  let selected: readonly CriterionPick[] | undefined
  for (;;) {
    selected = await vscode.window.showQuickPick(items, {
      title: 'Govern: select criteria',
      placeHolder: 'Choose at least one governance criterion to enforce',
      canPickMany: true,
    })
    if (selected === undefined) return undefined // cancelled
    if (selected.length > 0) break
    void vscode.window.showErrorMessage('Select at least one governance criterion.')
  }

  const checkers: CriterionChecker[] = []
  for (const pick of selected) {
    switch (pick.id) {
      case CRITERION_IDS.pii:
        checkers.push(makePurviewPiiChecker(content))
        break
      case CRITERION_IDS.promptInjection:
        checkers.push(promptInjectionChecker)
        break
      case CRITERION_IDS.toxicity:
        checkers.push(toxicityChecker)
        break
      case CRITERION_IDS.policyAdherence: {
        const policy = await vscode.window.showInputBox({
          title: 'Govern: policy statement',
          prompt: 'Enter the policy the content must adhere to',
          placeHolder: 'e.g. Must not promise refunds or disclose internal pricing',
        })
        if (policy === undefined) return undefined // cancelled
        if (!policy.trim()) {
          void vscode.window.showWarningMessage('Policy adherence skipped — no policy text entered.')
          break
        }
        checkers.push(makePolicyChecker(policy.trim()))
        break
      }
      case CRITERION_IDS.customRegex: {
        let value = ''
        for (;;) {
          const pattern = await vscode.window.showInputBox({
            title: 'Govern: custom regex',
            prompt: 'Enter a regex pattern. Content that MATCHES it fails the check.',
            placeHolder: 'e.g. (?i)confidential|internal-only',
            value,
          })
          if (pattern === undefined) return undefined // cancelled
          if (!pattern.trim()) break // skip this criterion
          try {
            new RegExp(pattern)
          } catch (err) {
            value = pattern
            void vscode.window.showErrorMessage(
              `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
            )
            continue
          }
          checkers.push(makeCustomRegexChecker(pattern.trim()))
          break
        }
        break
      }
    }
  }

  return checkers.length > 0 ? checkers : undefined
}

/**
 * PII checker that prefers Purview when enabled+reachable and falls back to the
 * shared heuristic. Built here (not in criteria.ts) because it touches config + auth.
 */
function makePurviewPiiChecker(content: string): CriterionChecker {
  return {
    id: CRITERION_IDS.pii,
    label: 'PII detection',
    async check(): Promise<CriterionResult> {
      const classification = await classifyContent(content, readPurviewConfig(), getToken)
      const summary = classification.sensitive
        ? `detected ${classification.types.map((t) => `${t.type}×${t.count}`).join(', ')}`
        : 'no sensitive types detected'
      return {
        criterion: CRITERION_IDS.pii,
        label: 'PII detection',
        pass: !classification.sensitive,
        detail: `(${classification.source}): ${summary}`,
        source: classification.source,
      }
    },
  }
}

export async function governAgent(arg: unknown, deps: GovernAgentDeps): Promise<void> {
  const agent = await resolveAgent(arg)
  if (!agent) {
    void vscode.window.showWarningMessage('No agent selected for governance.')
    return
  }

  // Step 1 — content.
  const content = await vscode.window.showInputBox({
    title: `Govern Agent: ${agent.name}`,
    prompt: 'Content to assess for governance',
    placeHolder: "Paste the agent's system prompt, a sample query, or any content to classify",
  })
  if (!content?.trim()) return

  // Step 2 — criteria.
  const checkers = await collectCriteria(content)
  if (!checkers) return

  const timestamp = new Date().toISOString()
  const runId = crypto.randomUUID()
  const evalId = crypto.randomUUID()

  deps.channel.reveal()
  deps.channel.log(runId, `Governance check for "${agent.name}"`)

  // Run each criterion independently.
  const results: CriterionResult[] = []
  for (const checker of checkers) {
    try {
      const r = await checker.check(content)
      results.push(r)
      deps.channel.log(runId, `  ${r.pass ? '✓' : '✗'} ${r.label}: ${r.detail}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        criterion: checker.id,
        label: checker.label,
        pass: false,
        detail: `check errored: ${msg}`,
        source: 'heuristic',
      })
      deps.channel.log(runId, `  ✗ ${checker.label}: errored — ${msg}`)
    }
  }

  const failed = results.filter((r) => !r.pass)
  const overallPass = failed.length === 0
  const gateReason = overallPass
    ? `all ${results.length} criteria passed`
    : `${failed.length} of ${results.length} criteria failed`
  deps.channel.log(runId, `Gate: ${overallPass ? 'PASSED' : 'FAILED'} — ${gateReason}`)

  // One AuditRecord per criterion (shared runId), matching the evaluator-per-record model.
  const records: AuditRecord[] = results.map((r) => ({
    schemaVersion: 1,
    runId,
    evalId,
    timestamp,
    step: 'governance',
    agentId: agent.id,
    evaluator: `${r.label} (${r.source})`,
    score: r.pass ? 1 : 0,
    threshold: 1,
    pass: r.pass,
    gateDecision: overallPass ? 'pass' : 'fail',
    gateReason,
    actor: agent.name,
    source: 'extension',
    tokensIn: 0,
    tokensOut: 0,
    projectEndpoint: '',
  }))

  await deps.store.append(records)
  deps.results.refresh(runId)
  await vscode.commands.executeCommand('sdlcGovernance.showEvaluations')

  if (overallPass) {
    void vscode.window.showInformationMessage(
      `Governance PASSED for "${agent.name}" — ${gateReason}.`,
    )
  } else {
    void vscode.window.showWarningMessage(
      `Governance FAILED for "${agent.name}" — ${gateReason}.`,
    )
  }
}
