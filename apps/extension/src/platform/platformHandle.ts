// What the rest of the extension needs from the platform connection that registerPlatform owns: the current
// client (undefined while disconnected), the signed-in user, connection changes and live events. The Agents and
// Workflows views' platform sections are built on this.

import type * as vscode from 'vscode'
import { can, type Me, type Permission, type PlatformEvent, type ProjectSummary } from '@sdlc/contracts'
import type { PlatformClient } from './platformClient'

export interface PlatformHandle {
  client(): PlatformClient | undefined
  /** The signed-in user, once loaded. */
  me(): Me | undefined
  /** Load the signed-in user if it isn't yet (undefined while disconnected or on error). */
  ensureMe(): Promise<Me | undefined>
  /** Fired on connect / disconnect / account change. */
  onDidChangeConnection: vscode.Event<void>
  /** Every live event from the platform (SSE). */
  onEvent: vscode.Event<PlatformEvent>
  /** Open a path of the web app (e.g. `/projects/PAY/workflow`). */
  openInBrowser(path: string): void
}

/** Client-side hint only (the API enforces it): may the user do `perm` in this project? */
export function canIn(handle: PlatformHandle, project: ProjectSummary, perm: Permission): boolean {
  const me = handle.me()
  if (!me) return false
  return can({ userId: me.user.id, orgRole: me.user.orgRole }, project.myRole ?? undefined, perm)
}
