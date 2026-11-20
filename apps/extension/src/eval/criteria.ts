// Phase 6 — governance criteria checkers (W-2).
//
// The pluggable core behind the ⛨ Govern wizard: each governance criterion is a
// `CriterionChecker` with one `check(content)` method, so adding a criterion is
// additive and each is independently unit-testable. All built-ins here are PURE
// (regex / word-list / substring) and run with no network — the heuristic layer
// that is always available. PII detection reuses the same heuristic the Purview
// fallback uses, so the two governance entry points agree.
//
// The Govern command may additionally route a criterion through Purview (e.g. PII
// when Purview is enabled); that lives in the command layer. These checkers are
// the local floor.

import { classifyHeuristic } from '../foundry/purviewClassify'

/** A single criterion's verdict for a piece of content. */
export interface CriterionResult {
  /** Stable id of the criterion that produced this. */
  criterion: string
  /** Human-readable label shown in the log and results tree. */
  label: string
  pass: boolean
  /** One-line explanation of why it passed/failed. */
  detail: string
  /** What produced the verdict. Built-ins are always 'heuristic'. */
  source: 'heuristic' | 'purview'
}

/** A pluggable governance criterion. */
export interface CriterionChecker {
  id: string
  label: string
  check(content: string): Promise<CriterionResult>
}

/** The criterion ids the wizard offers (kept in one place for the QuickPick + tests). */
export const CRITERION_IDS = {
  pii: 'pii',
  promptInjection: 'prompt-injection',
  toxicity: 'toxicity',
  policyAdherence: 'policy-adherence',
  customRegex: 'custom-regex',
} as const

export type CriterionId = (typeof CRITERION_IDS)[keyof typeof CRITERION_IDS]

function result(
  id: string,
  label: string,
  pass: boolean,
  detail: string,
): CriterionResult {
  return { criterion: id, label, pass, detail, source: 'heuristic' }
}

// ─── Built-in checkers ────────────────────────────────────────────────────────

/** PII / sensitive-information types via the shared heuristic detector. */
export const piiChecker: CriterionChecker = {
  id: CRITERION_IDS.pii,
  label: 'PII detection',
  async check(content) {
    const c = classifyHeuristic(content)
    if (!c.sensitive) {
      return result(this.id, this.label, true, 'no sensitive types detected')
    }
    const summary = c.types.map((t) => `${t.type}×${t.count}`).join(', ')
    return result(this.id, this.label, false, `detected ${summary}`)
  },
}

// Common prompt-injection / instruction-override phrasings. Deliberately broad —
// this is a flag-for-review heuristic, not a classifier.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (?:all )?(?:the )?(?:previous|prior|above) (?:instructions|prompts?|directions)/i,
  /disregard (?:the )?(?:previous|prior|above|system) (?:instructions|prompt|message)/i,
  /forget (?:everything|all) (?:you|that) (?:were told|know|above)/i,
  /you are (?:now )?(?:a |an )?(?:different|new) (?:ai|assistant|persona|character)/i,
  /(?:reveal|print|show|repeat) (?:your |the )?(?:system )?(?:prompt|instructions)/i,
  /override (?:your |the )?(?:safety|guard ?rails|restrictions|rules)/i,
]

export const promptInjectionChecker: CriterionChecker = {
  id: CRITERION_IDS.promptInjection,
  label: 'Prompt injection risk',
  async check(content) {
    for (const re of INJECTION_PATTERNS) {
      const m = content.match(re)
      if (m) {
        return result(this.id, this.label, false, `pattern matched — "${m[0]}"`)
      }
    }
    return result(this.id, this.label, true, 'no injection patterns matched')
  },
}

// A small, conservative toxic/harmful word list. Intentionally minimal — a
// fallback signal, not a moderation system. The real classifier is Purview /
// Foundry content safety; this catches the obvious in offline mode.
const TOXIC_WORDS = [
  'kill yourself',
  'kys',
  'hate you',
  'idiot',
  'stupid',
  'racist',
  'sexist',
  'die',
  'attack them',
]

export const toxicityChecker: CriterionChecker = {
  id: CRITERION_IDS.toxicity,
  label: 'Toxicity / harmful language',
  async check(content) {
    const lower = content.toLowerCase()
    const hits = TOXIC_WORDS.filter((w) => lower.includes(w))
    if (hits.length === 0) {
      return result(this.id, this.label, true, 'clean')
    }
    return result(this.id, this.label, false, `matched: ${hits.join(', ')}`)
  },
}

/**
 * Policy adherence: the user supplies a policy statement; we flag content that
 * appears to contradict it by checking for negation near the policy's key terms.
 * This is a coarse offline heuristic — a real policy evaluator would use the judge
 * model. Passes when no obvious violation signal is found.
 */
export function makePolicyChecker(policy: string): CriterionChecker {
  return {
    id: CRITERION_IDS.policyAdherence,
    label: 'Policy adherence',
    async check(content) {
      const keyTerms = policy
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4)
      const lower = content.toLowerCase()
      // Flag if the content explicitly negates/violates a policy key term.
      const violationSignals = keyTerms.filter((term) =>
        new RegExp(`\\b(?:no|not|never|without|don't|cannot|can't|violat\\w*)\\b[^.]{0,40}\\b${escapeRegex(term)}\\b`).test(lower),
      )
      if (violationSignals.length > 0) {
        return result(
          this.id,
          this.label,
          false,
          `possible violation of policy term(s): ${[...new Set(violationSignals)].join(', ')}`,
        )
      }
      return result(this.id, this.label, true, 'no obvious policy violation detected')
    },
  }
}

/**
 * Custom regex: flags content that MATCHES the user's pattern (a match is treated
 * as a failure — "this pattern must not appear"). The pattern is validated by the
 * wizard before this is built, but we compile defensively.
 */
export function makeCustomRegexChecker(pattern: string): CriterionChecker {
  let re: RegExp | undefined
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    re = undefined
  }
  return {
    id: CRITERION_IDS.customRegex,
    label: `Custom regex (/${pattern}/)`,
    async check(content) {
      if (!re) {
        return result(this.id, this.label, false, `invalid pattern: ${pattern}`)
      }
      const m = content.match(re)
      if (m) {
        return result(this.id, this.label, false, `pattern matched — "${m[0]}"`)
      }
      return result(this.id, this.label, true, 'pattern did not match')
    },
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
