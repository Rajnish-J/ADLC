// Phase 3 — the shared dataset builder. THE center of gravity for the phase.
//
// One InternalAgent[] + a resolved gate policy → the exact dataset JSON that
// BOTH the in-extension SDK run and the scaffolded ADO `AIAgentEvaluation@2`
// task consume. Building it once here is what keeps local runs and the CI gate
// in lockstep: the same evaluators, thresholds, sampling, and data mapping.
//
// Pure — no `vscode`, no network, no Date.now()/Math.random() (callers stamp the
// dataset name with a timestamp so this stays deterministic and testable).

import type { InternalAgent } from '../discovery/agentModel'
import type { SdlcStep } from './sdlcSteps'
import type { EvalDataset, EvaluatorRef, GatePolicy, SamplingPolicy, StepPolicy } from './types'

/**
 * Built-in evaluators whose Azure data_mapping REQUIRES a `tool_definitions`
 * field. Their presence in a step forces us to synthesize `tool_definitions`
 * onto every row (else `evals.create` is rejected with `MissingRequiredDataMapping`).
 */
const TOOL_DEFINITION_REQUIRED = new Set<EvaluatorRef>([
  'builtin.tool_call_accuracy',
  'builtin.tool_selection',
  'builtin.tool_input_accuracy',
  'builtin.tool_output_utilization',
])

/**
 * Built-in evaluators that CONSUME `tool_definitions` — required OR optional.
 * Azure validates the *run* with a symmetric rule: once the inline data carries
 * a field, EVERY evaluator that supports it must also map it, or the run is
 * rejected (`MissingRequiredDataMapping`, "field supported but not mapped").
 * So `task_adherence`/`intent_resolution` must map it too when a sibling tool
 * evaluator put it in the data — even though they don't require it themselves.
 */
const TOOL_DEFINITION_SUPPORTED = new Set<EvaluatorRef>([
  ...TOOL_DEFINITION_REQUIRED,
  'builtin.intent_resolution',
  'builtin.task_adherence',
  'builtin.groundedness',
])

/**
 * Built-in evaluators that need a non-empty `response` to score a row. Every
 * built-in we wire today does; an empty response makes them error per-row (the
 * `errored:N` symptom). The command uses this to block a run that can't produce
 * a response (e.g. auto-derive, which supplies only a query).
 */
const RESPONSE_EVALUATORS = new Set<EvaluatorRef>([
  'builtin.intent_resolution',
  'builtin.task_adherence',
  'builtin.coherence',
  'builtin.tool_call_accuracy',
  // Safety evaluators score the agent's response too.
  'builtin.violence',
  'builtin.hate_unfairness',
  'builtin.self_harm',
  'builtin.sexual',
  'builtin.code_vulnerability',
  'builtin.indirect_attack',
])

/** True when any evaluator in the set requires `tool_definitions` in the data. */
function needsToolDefinitions(evaluators: EvaluatorRef[]): boolean {
  return evaluators.some((e) => TOOL_DEFINITION_REQUIRED.has(e))
}

/**
 * The subset of evaluators that HARD-require `tool_definitions` to run. Foundry
 * treats an empty `tool_definitions` as "none", so these can't be evaluated for
 * an agent with no tools — the caller drops them (with a warning) rather than
 * sending an empty array that's guaranteed to error.
 */
export function toolRequiringEvaluators(evaluators: EvaluatorRef[]): EvaluatorRef[] {
  return evaluators.filter((e) => TOOL_DEFINITION_REQUIRED.has(e))
}

/** True when any evaluator in the set needs a non-empty `response` to score. */
export function requiresResponse(evaluators: EvaluatorRef[]): boolean {
  return evaluators.some((e) => RESPONSE_EVALUATORS.has(e))
}

/**
 * Synthesize OpenAI function-calling tool definitions from an agent's tool
 * names. `InternalAgent.tools` is a bare name list, so we emit a minimal
 * `{type, function}` descriptor per tool — enough to satisfy the tool_*
 * evaluators' required `tool_definitions` schema. Agents with no tools yield an
 * empty array, which still satisfies the mapping requirement.
 */
export function toolDefinitionsFor(agent: InternalAgent): Array<Record<string, unknown>> {
  return agent.tools.map((name) => ({
    type: 'function',
    function: {
      name,
      description: `Tool "${name}" available to ${agent.name}.`,
      parameters: { type: 'object', properties: {} },
    },
  }))
}

/**
 * Build the data_mapping for ONE evaluator. Each evaluator declares only the
 * fields it actually consumes, so e.g. `coherence` is not handed
 * `tool_definitions` (and is not rejected for an unexpected field), while
 * `tool_call_accuracy` is. Optional fields (`ground_truth`, `tool_definitions`)
 * are included only when the dataset rows actually carry them.
 */
export function dataMappingFor(
  evaluator: EvaluatorRef,
  has: { response: boolean; groundTruth: boolean; toolDefinitions: boolean },
): Record<string, string> {
  const mapping: Record<string, string> = { query: '{{item.query}}' }
  if (has.response) mapping.response = '{{item.response}}'
  if (has.groundTruth) mapping.ground_truth = '{{item.ground_truth}}'
  if (TOOL_DEFINITION_SUPPORTED.has(evaluator) && has.toolDefinitions) {
    mapping.tool_definitions = '{{item.tool_definitions}}'
  }
  return mapping
}

export interface BuildDatasetOptions {
  step: SdlcStep
  /** Stable, caller-supplied dataset name (e.g. `sdlc-review-<timestamp>`). */
  name: string
  /**
   * Optional pre-recorded responses keyed by agent id. When present, the row
   * carries a `response` for offline evaluation; otherwise the row only carries
   * `query` (the ADO task / agent target supplies the response at runtime).
   */
  responsesByAgentId?: Record<string, string>
  /**
   * Explicit dataset rows supplied by the user (Paste JSON / Load file in the
   * per-agent Evaluate wizard). When present they are used verbatim — each row
   * stamped with the first agent's id — instead of deriving a query per agent,
   * so all three wizard sources funnel through this one assembly path (W-1).
   */
  rows?: Array<Record<string, unknown>>
}

/** Apply the sampling policy to a list of rows. Deterministic (head-based). */
export function applySampling<T>(rows: T[], sampling: SamplingPolicy): T[] {
  if (rows.length === 0) {
    return rows
  }
  switch (sampling.strategy) {
    case 'none':
      return rows
    case 'headN': {
      const n = Math.max(0, sampling.n ?? rows.length)
      return rows.slice(0, n)
    }
    case 'ratio': {
      const ratio = sampling.ratio ?? 1
      const minRows = sampling.minRows ?? 0
      const keep = Math.max(minRows, Math.ceil(rows.length * ratio))
      return rows.slice(0, Math.min(rows.length, keep))
    }
    default:
      return rows
  }
}

/** Derive the test query for an agent: description first, else name. */
function deriveQuery(agent: InternalAgent): string {
  const base = agent.description?.trim() || agent.name
  return `Acting as "${agent.name}", ${base}`
}

/** The standard data mapping linking dataset columns to evaluator inputs. */
export function buildDataMapping(): Record<string, string> {
  return {
    query: '{{item.query}}',
    response: '{{item.response}}',
    ground_truth: '{{item.ground_truth}}',
  }
}

export function buildDataset(
  agents: InternalAgent[],
  policy: GatePolicy,
  opts: BuildDatasetOptions,
): EvalDataset {
  const step: StepPolicy = policy.steps[opts.step] ?? { evaluators: [], required: [], thresholds: {} }
  const wantsTools = needsToolDefinitions(step.evaluators)

  const rows =
    opts.rows && opts.rows.length > 0
      ? opts.rows.map((row) => {
          const built: Record<string, unknown> = { sdlc_agent_id: agents[0]?.id, ...row }
          // Stamp synthesized tool definitions only when a tool evaluator needs
          // them and the user's row didn't already carry its own.
          if (wantsTools && !('tool_definitions' in built) && agents[0]) {
            built.tool_definitions = toolDefinitionsFor(agents[0])
          }
          return built
        })
      : agents.map((agent) => {
          const row: Record<string, unknown> = {
            query: deriveQuery(agent),
            sdlc_agent_id: agent.id,
          }
          const response = opts.responsesByAgentId?.[agent.id]
          if (response !== undefined) {
            row.response = response
          }
          if (wantsTools) {
            row.tool_definitions = toolDefinitionsFor(agent)
          }
          return row
        })

  const sampled = applySampling(rows, policy.sampling)

  // evaluator_parameters carries the judge deployment plus per-evaluator
  // thresholds the ADO task and portal use to convert scaled scores → pass/fail.
  const evaluatorParameters: Record<string, unknown> = {
    deployment_name: policy.judgeDeployment,
  }
  for (const [evaluator, threshold] of Object.entries(step.thresholds)) {
    evaluatorParameters[evaluator] = { threshold }
  }

  // Which optional columns the rows actually carry — drives per-evaluator
  // mappings so we never reference a field the data doesn't have.
  const has = {
    response: sampled.some((r) => 'response' in r),
    groundTruth: sampled.some((r) => 'ground_truth' in r),
    toolDefinitions: sampled.some((r) => 'tool_definitions' in r),
  }
  const dataMappings: Record<EvaluatorRef, Record<string, string>> = {}
  for (const evaluator of step.evaluators) {
    dataMappings[evaluator] = dataMappingFor(evaluator, has)
  }

  return {
    name: opts.name,
    evaluators: [...step.evaluators],
    data: sampled,
    data_mapping: buildDataMapping(),
    dataMappings,
    evaluator_parameters: evaluatorParameters,
  }
}
