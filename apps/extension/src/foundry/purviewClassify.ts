// Pure Purview / heuristic PII classification, split from purview.ts so it carries no `vscode`
// dependency. purview.ts keeps the append-only JSONL store and re-exports everything here.

import { FOUNDRY_SCOPE } from './constants'
import type { TokenProvider } from './foundryClient'

export type SensitiveInfoType = 'email' | 'phone' | 'credit-card' | 'ssn' | 'ip-address'

export interface DetectedType {
  type: SensitiveInfoType
  count: number
}

export interface PurviewClassification {
  /** What produced the verdict — the Purview service, or the local heuristic fallback. */
  source: 'purview' | 'heuristic'
  types: DetectedType[]
  /** True when any sensitive type was detected. */
  sensitive: boolean
}

const PATTERNS: Record<SensitiveInfoType, RegExp> = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // 10+ digit runs allowing spaces/dashes/parens — deliberately broad for a fallback.
  phone: /(?:\+?\d[\d\s().-]{8,}\d)/g,
  'credit-card': /\b(?:\d[ -]?){13,16}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  'ip-address': /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
}

/**
 * Pure heuristic PII/SIT detection — no network. Conservative regex matches per type; this is the
 * always-available fallback so classification never depends on the preview Purview service.
 */
export function classifyHeuristic(text: string): PurviewClassification {
  const types: DetectedType[] = []
  for (const key of Object.keys(PATTERNS) as SensitiveInfoType[]) {
    const matches = text.match(PATTERNS[key])
    if (matches && matches.length > 0) types.push({ type: key, count: matches.length })
  }
  return { source: 'heuristic', types, sensitive: types.length > 0 }
}

export interface PurviewConfig {
  enabled: boolean
  /** Purview DSPM-for-AI classification endpoint (preview). */
  endpoint?: string
}

/**
 * Classify content. When Purview is enabled + configured, attempt the service and fall back to the
 * heuristic on any failure (preview API: no SLA). When disabled, use the heuristic directly.
 *
 * The optional `onError` hook reports a Purview failure to the caller (so the command layer can log
 * "Purview failed (403) — falling back to heuristic") WITHOUT changing the degrade-to-heuristic
 * behaviour: classification never fails the run just because the preview service is down (W-6, AC-7).
 */
export async function classifyContent(
  text: string,
  config: PurviewConfig,
  getToken: TokenProvider,
  onError?: (detail: { status: number; message: string; endpoint: string }) => void,
): Promise<PurviewClassification> {
  if (!config.enabled || !config.endpoint) return classifyHeuristic(text)
  const endpoint = `${config.endpoint.replace(/\/+$/, '')}/classify`
  try {
    const token = await getToken(FOUNDRY_SCOPE)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new PurviewApiError(res.status, body.slice(0, 200) || res.statusText)
    }
    const data = (await res.json()) as { types?: DetectedType[] }
    const types = data.types ?? []
    return { source: 'purview', types, sensitive: types.length > 0 }
  } catch (err) {
    // Preview service unreachable — report, then degrade to the local heuristic rather than failing.
    const status = err instanceof PurviewApiError ? err.status : 0
    const message = err instanceof Error ? err.message : String(err)
    onError?.({ status, message, endpoint })
    return classifyHeuristic(text)
  }
}

/** A non-2xx response from the preview Purview classify endpoint. */
export class PurviewApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Purview classify failed (${status}): ${body}`)
    this.name = 'PurviewApiError'
  }
}

export interface PurviewClassificationRecord {
  schemaVersion: 1
  timestamp: string
  runId?: string
  source: PurviewClassification['source']
  sensitive: boolean
  types: DetectedType[]
}

/** Pure: stamp a classification into an append-ready audit record (caller supplies timestamp). */
export function buildClassificationRecord(
  classification: PurviewClassification,
  timestamp: string,
  runId?: string,
): PurviewClassificationRecord {
  return {
    schemaVersion: 1,
    timestamp,
    runId,
    source: classification.source,
    sensitive: classification.sensitive,
    types: classification.types,
  }
}
