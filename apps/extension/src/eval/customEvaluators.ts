// Phase 3 — custom evaluators (PREVIEW, degrade-on-failure).
//
// Registers two custom evaluators in the project so they can be referenced from
// a dataset like any built-in:
//   • a CODE-BASED scorer (deterministic grade() — here, a non-empty/length
//     guard as a worked example of format rules);
//   • a PROMPT-BASED LLM-judge (friendliness/helpfulness).
//
// `project.beta.evaluators.*` is explicitly beta. Everything here is wrapped so
// that a preview API break NEVER blocks built-in evaluation — on any failure we
// log via the supplied reporter and return an empty list. The caller adds the
// returned names to the dataset only if registration succeeded.

const CODE_EVALUATOR_NAME = 'sdlc_response_length'
const PROMPT_EVALUATOR_NAME = 'sdlc_helpfulness'

const CODE_TEXT = `def grade(response: str = "", **kwargs) -> float:
    """1.0 when the response is substantive, scaling down when terse/empty."""
    text = (response or "").strip()
    if not text:
        return 0.0
    return min(1.0, len(text) / 200.0)
`

const PROMPT_TEXT = `You are grading whether an AI agent's response is helpful and on-task.
Query: {{query}}
Response: {{response}}
Score 1 (poor) to 5 (excellent) for helpfulness. Reply with only the integer.`

export interface CustomEvaluatorReporter {
  (message: string): void
}

// Minimal structural type for the (untyped, preview) evaluators surface.
interface EvaluatorsApi {
  createVersion(spec: Record<string, unknown>): Promise<unknown>
}
interface ProjectWithBeta {
  beta?: { evaluators?: EvaluatorsApi }
}

/**
 * Ensure the custom evaluators exist for this project. Returns the evaluator
 * names that are safe to reference in a dataset. On any preview failure, returns
 * [] and reports — built-in evaluation proceeds regardless.
 */
export async function ensureCustomEvaluators(
  project: unknown,
  judgeDeployment: string,
  report: CustomEvaluatorReporter,
): Promise<string[]> {
  const names: string[] = []
  const evaluators = (project as ProjectWithBeta | undefined)?.beta?.evaluators
  if (!evaluators || typeof evaluators.createVersion !== 'function') {
    report('Custom evaluators skipped — preview API (project.beta.evaluators) unavailable.')
    return names
  }

  try {
    await evaluators.createVersion({
      name: CODE_EVALUATOR_NAME,
      type: 'code',
      code_text: CODE_TEXT,
      data_schema: {
        type: 'object',
        properties: { response: { type: 'string' } },
      },
      metrics: [{ name: 'score', type: 'continuous', min: 0, max: 1 }],
    })
    names.push(CODE_EVALUATOR_NAME)
  } catch (err) {
    report(`Code-based custom evaluator skipped: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    await evaluators.createVersion({
      name: PROMPT_EVALUATOR_NAME,
      type: 'prompt',
      prompt_text: PROMPT_TEXT,
      data_schema: {
        type: 'object',
        properties: { query: { type: 'string' }, response: { type: 'string' } },
      },
      metrics: [{ name: 'score', type: 'ordinal', min: 1, max: 5 }],
      init_parameters: { deployment_name: judgeDeployment },
    })
    names.push(PROMPT_EVALUATOR_NAME)
  } catch (err) {
    report(`Prompt-based custom evaluator skipped: ${err instanceof Error ? err.message : String(err)}`)
  }

  return names
}
