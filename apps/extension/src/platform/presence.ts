// This VS Code window's presence on the platform (Settings → VS Code in the web app): while connected, a heartbeat
// every minute — and whenever extensions change — reports the extension version, the agent engines installed here
// and the workspace's repository and branch. The heartbeat's answer carries the user's preferred agent engine
// (Settings → Agent engine), which is applied to `sdlcGovernance.aiAssistant` so both UIs agree.

import { createHash, randomUUID } from 'crypto'
import * as vscode from 'vscode'
import type { ClientPresenceInput, MySettings } from '@sdlc/contracts'
import { getOriginRemote, getRepository } from '../integrations/git/gitRepository'
import { installedHarnesses } from './engines/registry'
import type { PlatformClient } from './platformClient'

const HEARTBEAT_MS = 60_000
const CLIENT_ID_KEY = 'sdlcGovernance.platform.clientId'
/** The engines `sdlcGovernance.aiAssistant` accepts. */
const ASSISTANT_VALUES = new Set<string>(['copilot', 'claude-code', 'codex'])

export interface Presence extends vscode.Disposable {
  /** The client changed (connect, disconnect, new settings): say goodbye on the old one, report on the new one. */
  reset(): void
  /** Report now (e.g. the user's preferences changed on the web). */
  beat(): void
}

/**
 * This window's id on the platform: the installation's id plus the workspace folder, so two VS Code windows are two
 * clients (the web can send a run to the right one). Stable across reloads.
 */
export function presenceClientId(context: vscode.ExtensionContext): string {
  let installation = context.globalState.get<string>(CLIENT_ID_KEY)
  if (!installation) {
    installation = randomUUID()
    void context.globalState.update(CLIENT_ID_KEY, installation)
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'no-folder'
  return createHash('sha1').update(`${installation}|${folder}`).digest('hex').slice(0, 32)
}

async function workspace(): Promise<ClientPresenceInput['workspace']> {
  try {
    const repo = await getRepository()
    if (!repo) return null
    const remote = getOriginRemote(repo)
    return {
      remoteUrl: remote?.fetchUrl ?? remote?.pushUrl ?? null,
      branch: repo.state.HEAD?.name ?? null,
      name: vscode.workspace.workspaceFolders?.[0]?.name ?? null,
    }
  } catch {
    return null
  }
}

async function applyPreferences(settings: MySettings, log: (m: string) => void): Promise<void> {
  const engine = settings.preferences.agentEngine
  if (!engine || !ASSISTANT_VALUES.has(engine)) return
  const config = vscode.workspace.getConfiguration('sdlcGovernance')
  if (config.get<string>('aiAssistant') === engine) return
  await config.update('aiAssistant', engine, vscode.ConfigurationTarget.Global)
  log(`Agent engine set to ${engine} from your platform preference.`)
}

export function startPresence(context: vscode.ExtensionContext, client: () => PlatformClient | undefined, log: (m: string) => void): Presence {
  const id = presenceClientId(context)
  const version = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0')
  let current: PlatformClient | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const beat = (): void => {
    const c = current
    if (!c) return
    void (async () => {
      try {
        const settings = await c.reportPresence(id, { kind: 'vscode', version, engines: installedHarnesses(), workspace: await workspace() })
        await applyPreferences(settings, log)
      } catch {
        /* the platform is unreachable or we were signed out — the next beat tries again */
      }
    })()
  }

  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = undefined
    if (current) void current.removePresence(id).catch(() => undefined)
    current = undefined
  }

  const reset = (): void => {
    stop()
    current = client()
    if (!current) return
    beat()
    timer = setInterval(beat, HEARTBEAT_MS)
  }

  const extensionsChanged = vscode.extensions.onDidChange(() => beat())
  return {
    reset,
    beat,
    dispose: () => {
      extensionsChanged.dispose()
      stop()
    },
  }
}
