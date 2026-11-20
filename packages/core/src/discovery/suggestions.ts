// Agent quality suggestions — rule-based "is this good enough to use?" checks.
//
// The validator (validator.ts) flags hard problems (missing name/body, malformed
// YAML). This module is the softer, advisory layer: it inspects a normalized
// InternalAgent against a set of tunable quality rules and emits human-readable
// suggestions for improving the manifest. The rules come from a user-editable
// `.claude/governance/agent-quality.yaml` (loaded by qualityConfig.ts); when that
// file is absent DEFAULT_QUALITY_RULES apply.
//
// Pure — no `vscode`, no I/O — so it is trivially unit-testable.

import * as yaml from 'js-yaml'
import type { InternalAgent } from './agentModel'

/** A single advisory hint about an agent's quality. */
export interface Suggestion {
  /** Identifies which rule produced this suggestion. */
  ruleId: string
  /** Human-readable, actionable message shown in the tree. */
  message: string
}

/** Tunable quality rules, read from `.claude/governance/agent-quality.yaml`. */
export interface QualityRules {
  /** Suggest a richer description when shorter than this (chars). 0 disables. */
  minDescriptionLength: number
  /** Suggest naming trigger phrases when the description has none. */
  requireTriggerPhrases: boolean
  /** Suggest declaring tools when none are listed. */
  requireToolsDeclared: boolean
  /** Suggest a more substantial body when shorter than this (chars). 0 disables. */
  minInstructionsLength: number
  /** Suggest pinning a model when none is declared. */
  requireModel: boolean
  /** Surface a review reminder when a skill bundles executable scripts. */
  flagBundledScripts: boolean
  /** Per-rule message overrides (rule id → text). */
  messages: Partial<Record<RuleId, string>>
}

type RuleId =
  | 'minDescriptionLength'
  | 'requireTriggerPhrases'
  | 'requireToolsDeclared'
  | 'minInstructionsLength'
  | 'requireModel'
  | 'flagBundledScripts'

/** Built-in defaults — used when no criteria file is present. */
export const DEFAULT_QUALITY_RULES: QualityRules = {
  minDescriptionLength: 40,
  requireTriggerPhrases: true,
  requireToolsDeclared: false,
  minInstructionsLength: 80,
  requireModel: false,
  flagBundledScripts: true,
  messages: {},
}

const DEFAULT_MESSAGES: Record<RuleId, string> = {
  minDescriptionLength:
    'Add a richer description (with trigger phrases) so this agent is discoverable.',
  requireTriggerPhrases:
    'Describe when to use this agent (e.g. "Triggers on …") so it can be matched to tasks.',
  requireToolsDeclared: 'Declare the tools this agent needs.',
  minInstructionsLength:
    'Flesh out the system prompt — the current body is too thin to be reliable.',
  requireModel: 'Pin a model so behaviour is reproducible.',
  flagBundledScripts: 'Bundles executable scripts — review them before trusting this agent.',
}

/** Detects an explicit "when to use" cue in a description. */
const TRIGGER_HINT = /trigger|use (this|when)|when (the|you|asked)|"[^"]+"/i

/** Run the quality rules against an agent and return advisory suggestions. */
export function evaluateSuggestions(agent: InternalAgent, rules: QualityRules): Suggestion[] {
  // Manifests we couldn't parse are already an error elsewhere; advising on an
  // empty shell adds only noise.
  if (agent.status === 'skipped') {
    return []
  }

  const out: Suggestion[] = []
  const add = (ruleId: RuleId): void => {
    out.push({ ruleId, message: rules.messages[ruleId] || DEFAULT_MESSAGES[ruleId] })
  }

  const description = agent.description.trim()
  const instructions = agent.instructions.trim()

  if (rules.minDescriptionLength > 0 && description.length < rules.minDescriptionLength) {
    add('minDescriptionLength')
  }
  if (rules.requireTriggerPhrases && description && !TRIGGER_HINT.test(description)) {
    add('requireTriggerPhrases')
  }
  if (rules.requireToolsDeclared && agent.tools.length === 0) {
    add('requireToolsDeclared')
  }
  if (rules.minInstructionsLength > 0 && instructions.length < rules.minInstructionsLength) {
    add('minInstructionsLength')
  }
  if (rules.requireModel && !agent.model) {
    add('requireModel')
  }
  if (rules.flagBundledScripts && agent.hasBundledScripts) {
    add('flagBundledScripts')
  }

  return out
}

/**
 * Parse a `.claude/governance/agent-quality.yaml` document into QualityRules.
 * Tolerant: unknown keys are ignored and any missing/invalid field falls back to
 * its default, so a partial or slightly malformed file never disables the feature.
 */
export function parseQualityRules(yamlText: string): QualityRules {
  let doc: Record<string, unknown> = {}
  try {
    const parsed = yaml.load(yamlText.replace(/^﻿/, ''))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>
    }
  } catch {
    return { ...DEFAULT_QUALITY_RULES }
  }

  const num = (key: keyof QualityRules, fallback: number): number => {
    const v = doc[key]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
  }
  const bool = (key: keyof QualityRules, fallback: boolean): boolean => {
    const v = doc[key]
    return typeof v === 'boolean' ? v : fallback
  }

  const messages: Partial<Record<RuleId, string>> = {}
  if (doc.messages && typeof doc.messages === 'object' && !Array.isArray(doc.messages)) {
    for (const [key, value] of Object.entries(doc.messages as Record<string, unknown>)) {
      if (key in DEFAULT_MESSAGES && typeof value === 'string' && value.trim()) {
        messages[key as RuleId] = value.trim()
      }
    }
  }

  return {
    minDescriptionLength: num('minDescriptionLength', DEFAULT_QUALITY_RULES.minDescriptionLength),
    requireTriggerPhrases: bool('requireTriggerPhrases', DEFAULT_QUALITY_RULES.requireTriggerPhrases),
    requireToolsDeclared: bool('requireToolsDeclared', DEFAULT_QUALITY_RULES.requireToolsDeclared),
    minInstructionsLength: num('minInstructionsLength', DEFAULT_QUALITY_RULES.minInstructionsLength),
    requireModel: bool('requireModel', DEFAULT_QUALITY_RULES.requireModel),
    flagBundledScripts: bool('flagBundledScripts', DEFAULT_QUALITY_RULES.flagBundledScripts),
    messages,
  }
}
