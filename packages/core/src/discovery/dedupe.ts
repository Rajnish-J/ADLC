// Dedupe — collapse the same agent declared across multiple conventions.
//
// Keyed by slug(name). When several files declare the same agent, the
// highest-priority source (see SOURCE_PRIORITY) survives and records the other
// source kinds in `alsoSeenIn`. Unnamed/skipped manifests are never merged (no
// reliable key) so each surfaces its own diagnostic. Pure — no `vscode`.

import { agentKindOf, slug, type InternalAgent } from './agentModel'
import { sourceRank } from './adapters'

export interface DedupeOptions {
  /**
   * Merge only within the same kind (agent vs skill), so a skill and an agent that share a name both survive.
   * The platform catalog uses this; the extension's local tree merges across kinds.
   */
  byKind?: boolean
}

export function dedupe(agents: InternalAgent[], opts: DedupeOptions = {}): InternalAgent[] {
  const groups = new Map<string, InternalAgent[]>()
  const standalone: InternalAgent[] = []

  for (const agent of agents) {
    const nameKey = slug(agent.name)
    const key = opts.byKind && nameKey ? `${agentKindOf(agent.sourceKind)}:${nameKey}` : nameKey
    // Don't merge placeholders or unparseable manifests — they have no reliable
    // identity and each deserves its own Problems-panel entry.
    if (!nameKey || nameKey === 'unnamed' || agent.status === 'skipped') {
      standalone.push(agent)
      continue
    }
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(agent)
    } else {
      groups.set(key, [agent])
    }
  }

  const merged: InternalAgent[] = []
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      merged.push(bucket[0])
      continue
    }
    bucket.sort((a, b) => sourceRank(a.sourceKind) - sourceRank(b.sourceKind))
    const [survivor, ...rest] = bucket
    const alsoSeenIn = Array.from(
      new Set(rest.map((a) => a.sourceKind).filter((k) => k !== survivor.sourceKind)),
    )
    merged.push({ ...survivor, alsoSeenIn: alsoSeenIn.length ? alsoSeenIn : undefined })
  }

  return [...merged, ...standalone]
}
