// Pure discovery transform (dedupe + stable sort), split from normalizer.ts so it carries no `vscode`
// dependency — the backend reuses it when importing agents into the catalog.

import { SOURCE_LABELS, type InternalAgent } from './agentModel'
import { dedupe, type DedupeOptions } from './dedupe'

export interface DiscoveryResult {
  agents: InternalAgent[]
  /** Count before dedupe — useful for "merged N duplicates" messaging. */
  rawCount: number
}

/** Pure transform: dedupe + stable sort (by source kind, then name). */
export function normalize(raw: InternalAgent[], opts: DedupeOptions = {}): InternalAgent[] {
  const deduped = dedupe(raw, opts)
  const order = Object.keys(SOURCE_LABELS) as InternalAgent['sourceKind'][]
  return deduped.sort((a, b) => {
    const ka = order.indexOf(a.sourceKind)
    const kb = order.indexOf(b.sourceKind)
    if (ka !== kb) {
      return ka - kb
    }
    return a.name.localeCompare(b.name)
  })
}
