// Normalizer — the discovery orchestrator.
//
// scan → dedupe → sorted InternalAgent[]. Thin glue so the tree view and the
// `discover` command have a single entry point. The pure transform (dedupe +
// sort) is exported separately so it can be unit-tested without `vscode`.

import type * as vscode from 'vscode'
import { normalize, type DiscoveryResult } from './normalize'
import { evaluateSuggestions } from './suggestions'

export { normalize, type DiscoveryResult } from './normalize'

/**
 * Full discovery pass over the open workspace. The scanner (the only `vscode`-FS
 * module) is imported lazily so this file's pure `normalize` transform can be
 * unit-tested in plain Node without loading the `vscode` host shim.
 */
export async function discover(token?: vscode.CancellationToken): Promise<DiscoveryResult> {
  const { scanWorkspace } = await import('./scanner')
  const { loadQualityRules } = await import('./qualityConfig')
  const raw = await scanWorkspace(token)
  const agents = normalize(raw)

  // Attach advisory quality suggestions. Done here (not in the pure `normalize`
  // transform) so it can read the workspace's criteria file without pulling
  // `vscode` into the unit-tested transform.
  const rules = await loadQualityRules()
  for (const agent of agents) {
    agent.suggestions = evaluateSuggestions(agent, rules)
  }

  return { agents, rawCount: raw.length }
}
