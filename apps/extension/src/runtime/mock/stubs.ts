// Phase 4 — stub implementations of the injected ports, for the mock runtime + tests.
//
// StubAgentDispatcher echoes a deterministic response (no network). StubGateEvaluator applies a simple
// keyword rule mirroring the spike's gate-endpoint stub, so the gate's halt-on-fail path is exercised
// without Foundry Evals. The real runtime swaps these for a Foundry dispatcher and evalClient + decideGate.

import { decideGate } from '../../eval/gateDecision'
import type { EvalScore, GateDecision } from '../../eval/types'
import { DEFAULT_STEP_EVALUATORS, type SdlcStep } from '../../eval/sdlcSteps'
import type {
  AgentDispatcher,
  AgentDispatchInput,
  AgentDispatchResult,
  GateEvaluator,
} from '../port'

/** Deterministic agent stub. Optionally scripted per agent name for tests. */
export class StubAgentDispatcher implements AgentDispatcher {
  constructor(private readonly scripted: Record<string, string> = {}) {}

  async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
    const response =
      input.phase === 'plan'
        ? this.scripted[`${input.agentName}:plan`] ??
          `[${input.agentName}] plan: 1. Review "${input.prompt.slice(0, 60)}". 2. Produce the deliverable.`
        : this.scripted[input.agentName] ??
          `[${input.agentName}] processed: ${input.prompt.slice(0, 80)}`
    return {
      response,
      tokensIn: Math.max(1, Math.ceil(input.prompt.length / 4)),
      tokensOut: Math.max(1, Math.ceil(response.length / 4)),
    }
  }
}

// Phrases that mention failing without reporting one ("0 failed", "no failures", "did not fail", "fail-safe",
// "fixed the failing test"). Mirrors services/orchestrator/app/gates/stub.py.
const BENIGN_FAIL =
  /\b(?:0|no|zero|none)\s+(?:\w+\s+)?fail(?:ed|ures?|ing|s)?\b|\bfail(?:ed|ures?|s)?\s*[:=]\s*0\b|\b(?:not|never|didn'?t|did\s+not|won'?t|will\s+not|doesn'?t|does\s+not|without)\s+fail(?:ed|ures?|ing|s)?\b|\bfail[- ]?(?:over|safe|fast)\b|\bfix(?:ed|es|ing)?\s+(?:\w+\s+){0,3}?fail(?:ing|ed|ures?)\b|\bpreviously\s+fail(?:ing|ed)\b/gi
const FAILURES_HEADING = /^[ \t]*#{1,6}[ \t]*fail(?:ures?|ed|ing)?\b[^\n]*$/gim
const NEXT_HEADING = /^[ \t]*#{1,6}[ \t]/gm

/** The items of every `## Failures` section (null when there is none) and the text with those sections cut. */
function splitFailures(text: string): { items: string[] | null; rest: string } {
  let items: string[] | null = null
  let rest = ''
  let pos = 0
  for (const m of text.matchAll(FAILURES_HEADING)) {
    const start = m.index ?? 0
    if (start < pos) continue
    rest += text.slice(pos, start)
    const after = start + m[0].length
    NEXT_HEADING.lastIndex = after
    const next = NEXT_HEADING.exec(text)
    const end = next ? next.index : text.length
    items ??= []
    for (const line of text.slice(after, end).split(/\r?\n/)) {
      const item = line.replace(/^[\s>*+-]*(?:\d+[.)]\s*)?/, '').trim()
      if (item && !item.startsWith('```')) items.push(item)
    }
    pos = end
  }
  return { items, rest: rest + text.slice(pos) }
}

function isNothing(item: string): boolean {
  const first = (item.split(/\s+/)[0] ?? '').toLowerCase()
  return ['none', 'none.', 'n/a', 'na', 'nothing', '-', '—'].includes(first) || /^no\s+failures?\b/i.test(item)
}

/**
 * True when the output is empty or reports a failure (mentions of zero failures don't count). A `## Failures`
 * section (the agents' report format) decides by its items: `- none` passes, any real item fails.
 */
export function reportsFailure(text: string): boolean {
  if (!text.trim()) return true
  const { items, rest } = splitFailures(text)
  if (items?.some((i) => !isNothing(i))) return true
  return /\bfail/i.test(rest.replace(BENIGN_FAIL, ' '))
}

/**
 * Stub gate using the real Phase-3 `decideGate` over synthetic scores. Fails when the output reports a
 * failure ("FAIL", "2 tests failed" — not "0 failed") or is empty — enough to drive both branches. Reuses the actual step policy
 * (required evaluators + thresholds) so the decision shape matches production.
 */
export class StubGateEvaluator implements GateEvaluator {
  async evaluate(input: { sdlcStep: SdlcStep; output: string }): Promise<GateDecision> {
    const text = input.output ?? ''
    const bad = reportsFailure(text)
    const policy = DEFAULT_STEP_EVALUATORS[input.sdlcStep]
    const scores: EvalScore[] = policy.evaluators.map((evaluator) => {
      const threshold = policy.thresholds[evaluator] ?? 3
      // Pass comfortably above / fail below threshold on the 1–5 scale.
      const score = bad ? Math.max(1, threshold - 1) : Math.min(5, threshold + 1)
      return { evaluator, score, passed: bad ? 0 : 1, failed: bad ? 1 : 0, errored: 0 }
    })
    return decideGate(scores, policy, true)
  }
}
