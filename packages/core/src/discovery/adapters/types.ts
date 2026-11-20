// Adapter contract — one adapter per manifest convention.
//
// Adapters are PURE: `parse(relPath, content)` takes a workspace-relative path and
// the file's text and returns zero or more InternalAgent. No `vscode` import, no
// filesystem, no execution — which makes every adapter unit-testable in plain Node
// and keeps the "never execute discovered code" guarantee structural, not
// incidental. All FS I/O lives in src/discovery/scanner.ts.

import type { InternalAgent } from '../agentModel'

export interface DiscoveryAdapter {
  /** The source kind every agent from this adapter is tagged with. */
  readonly kind: InternalAgent['sourceKind']
  /** Glob(s), relative to a workspace folder, that select candidate files. */
  readonly globs: readonly string[]
  /**
   * Parse one file into zero or more agents. MUST NOT throw — malformed input
   * should yield an agent with status 'skipped'/'needs-attention' and an issue,
   * or [] when the file clearly isn't this convention.
   */
  parse(relPath: string, content: string): InternalAgent[]
}
