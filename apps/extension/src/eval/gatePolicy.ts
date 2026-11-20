// Phase 3 — gate policy resolution.
//
// Two layers, workspace wins:
//   1. `package.json` contributes.configuration → org-wide defaults (passed in
//      as a plain object so this module stays `vscode`-free and testable).
//   2. `.sdlc/governance.eval.json` in the workspace → per-repo overrides
//      (source-controlled, reviewable in PRs).
//
// `resolveGatePolicy` deep-merges the parsed workspace file OVER the config
// defaults OVER the hard-coded DEFAULT_STEP_EVALUATORS, so a repo only has to
// specify what it changes.

import { DEFAULT_STEP_EVALUATORS, SDLC_STEPS, type SdlcStep } from './sdlcSteps'
import type { GatePolicy, SamplingPolicy, StepPolicy } from './types'

/** The subset of extension configuration that feeds policy defaults. */
export interface EvalConfigDefaults {
  judgeDeployment?: string
  sampling?: Partial<SamplingPolicy>
  failClosedOnError?: boolean
  /** Per-evaluator default thresholds applied when a step omits one. */
  defaultThresholds?: Record<string, number>
}

const BUILT_IN_DEFAULTS: GatePolicy = {
  judgeDeployment: 'gpt-4o',
  sampling: { strategy: 'ratio', ratio: 0.25, minRows: 5 },
  failClosedOnError: true,
  steps: DEFAULT_STEP_EVALUATORS,
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function mergeStep(base: StepPolicy | undefined, over: unknown, fallbackThresholds?: Record<string, number>): StepPolicy {
  const b: StepPolicy = base ?? { evaluators: [], required: [], thresholds: {} }
  if (!isObject(over)) {
    return { ...b, thresholds: { ...fallbackThresholds, ...b.thresholds } }
  }
  const evaluators = Array.isArray(over.evaluators) ? (over.evaluators as string[]) : b.evaluators
  const required = Array.isArray(over.required) ? (over.required as string[]) : b.required
  const thresholds = {
    ...fallbackThresholds,
    ...b.thresholds,
    ...(isObject(over.thresholds) ? (over.thresholds as Record<string, number>) : {}),
  }
  return { evaluators, required, thresholds }
}

/**
 * Resolve the effective gate policy.
 *
 * @param workspaceFile  parsed `.sdlc/governance.eval.json` (or undefined/null)
 * @param config         extension configuration defaults (or undefined)
 */
export function resolveGatePolicy(
  workspaceFile: unknown,
  config?: EvalConfigDefaults,
): GatePolicy {
  // Layer config over built-in defaults.
  const judgeDeployment = config?.judgeDeployment?.trim() || BUILT_IN_DEFAULTS.judgeDeployment
  const sampling: SamplingPolicy = { ...BUILT_IN_DEFAULTS.sampling, ...(config?.sampling ?? {}) }
  const failClosedOnError = config?.failClosedOnError ?? BUILT_IN_DEFAULTS.failClosedOnError
  const fallbackThresholds = config?.defaultThresholds

  const wf = isObject(workspaceFile) ? workspaceFile : {}

  const resolved: GatePolicy = {
    judgeDeployment:
      typeof wf.judgeDeployment === 'string' && wf.judgeDeployment.trim()
        ? wf.judgeDeployment.trim()
        : judgeDeployment,
    sampling: isObject(wf.sampling) ? { ...sampling, ...(wf.sampling as Partial<SamplingPolicy>) } : sampling,
    failClosedOnError:
      typeof wf.failClosedOnError === 'boolean' ? wf.failClosedOnError : failClosedOnError,
    steps: {},
  }

  const wfSteps = isObject(wf.steps) ? (wf.steps as Record<string, unknown>) : {}
  for (const step of SDLC_STEPS) {
    const base = BUILT_IN_DEFAULTS.steps[step]
    const over = wfSteps[step]
    if (base || over) {
      resolved.steps[step] = mergeStep(base, over, fallbackThresholds)
    }
  }
  // Allow custom step keys present only in the workspace file.
  for (const key of Object.keys(wfSteps)) {
    if (!(key in resolved.steps)) {
      resolved.steps[key as SdlcStep] = mergeStep(undefined, wfSteps[key], fallbackThresholds)
    }
  }

  return resolved
}
