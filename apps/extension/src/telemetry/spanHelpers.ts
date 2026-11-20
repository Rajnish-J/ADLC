// Phase 3 — pure span attribute builders. No OTEL import here, so the privacy
// rules are unit-testable without loading the SDK.
//
// Emits OpenTelemetry GenAI semantic-convention attributes plus SDLC-specific
// ones. CONTENT RECORDING IS OFF BY DEFAULT: prompts/completions are only added
// when `recordContent` is explicitly true (the privacy regression guard).

import type { SdlcStep } from '../eval/sdlcSteps'
import type { EvalRunResult, GateDecision } from '../eval/types'

export interface SpanAttributeInput {
  result: EvalRunResult
  decision: GateDecision
  step: SdlcStep
  judgeDeployment: string
  recordContent: boolean
  /** Only consulted when recordContent is true. */
  content?: { prompt?: string; completion?: string }
}

export type SpanAttributes = Record<string, string | number | boolean>

/** Build the attribute bag for the top-level `gen_ai.evaluate` span. */
export function buildRunSpanAttributes(input: SpanAttributeInput): SpanAttributes {
  const attrs: SpanAttributes = {
    'gen_ai.system': 'az.ai.foundry',
    'gen_ai.operation.name': 'evaluate',
    'gen_ai.request.model': input.judgeDeployment,
    'gen_ai.usage.input_tokens': input.result.usage.tokensIn,
    'gen_ai.usage.output_tokens': input.result.usage.tokensOut,
    'sdlc.run_id': input.result.runId,
    'sdlc.eval_id': input.result.evalId,
    'sdlc.step': input.step,
    'sdlc.gate.decision': input.decision.pass ? 'pass' : 'fail',
    'sdlc.gate.reason': input.decision.reason,
  }

  // Privacy: content attributes are NEVER set unless explicitly opted in.
  if (input.recordContent && input.content) {
    if (input.content.prompt !== undefined) {
      attrs['gen_ai.prompt'] = input.content.prompt
    }
    if (input.content.completion !== undefined) {
      attrs['gen_ai.completion'] = input.content.completion
    }
  }
  return attrs
}

/** Build attributes for a per-evaluator child span. */
export function buildEvaluatorSpanAttributes(
  evaluator: string,
  score: number | null,
  pass: boolean,
): SpanAttributes {
  const attrs: SpanAttributes = {
    'sdlc.evaluator': evaluator,
    'sdlc.evaluator.pass': pass,
  }
  if (score !== null) {
    attrs['sdlc.evaluator.score'] = score
  }
  return attrs
}
