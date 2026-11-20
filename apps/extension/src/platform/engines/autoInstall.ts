// Claude Code and Codex come with this extension by default. The manifest lists them as an extension pack, so
// installing from the Marketplace brings them along; this covers every other way the extension arrives (a VSIX,
// a pack the user trimmed, a machine set up before the pack existed) by installing whichever is missing, once per
// extension version. Users can turn it off (sdlcGovernance.harnesses.autoInstall) and still uninstall either one.
// Each harness needs its own sign-in before it can run work — installing only makes it available.

import * as vscode from 'vscode'

export interface DefaultHarness {
  id: string
  label: string
  extensionId: string
}

/** The harnesses this extension installs by default (keep in sync with `extensionPack` in package.json). */
export const DEFAULT_HARNESSES: readonly DefaultHarness[] = [
  { id: 'claude-code', label: 'Claude Code', extensionId: 'anthropic.claude-code' },
  { id: 'codex', label: 'Codex', extensionId: 'openai.chatgpt' },
]

const ATTEMPT_KEY = 'sdlcGovernance.defaultHarnessesAttempt'
const DONT_ASK_KEY = 'sdlcGovernance.defaultHarnessesDontAsk'

/** The default harnesses not installed yet (extension ids compare case-insensitively, as VS Code's do). */
export function missingDefaults(isInstalled: (extensionId: string) => boolean, defaults: readonly DefaultHarness[] = DEFAULT_HARNESSES): DefaultHarness[] {
  return defaults.filter((h) => !isInstalled(h.extensionId))
}

const installedHere = (extensionId: string): boolean =>
  !!vscode.extensions.getExtension(extensionId) ||
  vscode.extensions.all.some((e) => e.id.toLowerCase() === extensionId.toLowerCase())

/**
 * Install the missing default harnesses. `force` (the command) installs even when auto-install is off or was
 * already tried for this version. Returns the harnesses that were installed.
 */
export async function installDefaultHarnesses(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
  force = false,
): Promise<DefaultHarness[]> {
  const missing = missingDefaults(installedHere)
  if (missing.length === 0) {
    if (force) void vscode.window.showInformationMessage('Claude Code and Codex are already installed.')
    return []
  }
  const version = String((context.extension.packageJSON as { version?: string }).version ?? '0')
  if (!force) {
    if (!vscode.workspace.getConfiguration('sdlcGovernance').get<boolean>('harnesses.autoInstall', true)) return []
    if (context.globalState.get<boolean>(DONT_ASK_KEY)) return []
    if (context.globalState.get<string>(ATTEMPT_KEY) === version) return []
  }
  await context.globalState.update(ATTEMPT_KEY, version)

  const installed: DefaultHarness[] = []
  const failed: DefaultHarness[] = []
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'SDLC Governance: installing coding harnesses' },
    async (progress) => {
      for (const h of missing) {
        progress.report({ message: h.label })
        try {
          await vscode.commands.executeCommand('workbench.extensions.installExtension', h.extensionId)
          installed.push(h)
          log(`Installed ${h.label} (${h.extensionId}).`)
        } catch (err) {
          failed.push(h)
          log(`Could not install ${h.label} (${h.extensionId}): ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },
  )

  if (installed.length) {
    void vscode.window.showInformationMessage(
      `${installed.map((h) => h.label).join(' and ')} ${installed.length === 1 ? 'is' : 'are'} installed. Sign in to ${installed.length === 1 ? 'it' : 'each'} before starting a run in ${installed.length === 1 ? 'it' : 'them'}.`,
    )
  }
  if (failed.length) {
    const names = failed.map((h) => h.label).join(' and ')
    const choice = await vscode.window.showWarningMessage(
      `Could not install ${names} (offline, or blocked by policy). Install ${failed.length === 1 ? 'it' : 'them'} from the Marketplace to run workflows there.`,
      'Open Marketplace',
      "Don't Ask Again",
    )
    if (choice === 'Open Marketplace') {
      await vscode.commands.executeCommand('workbench.extensions.search', failed.map((h) => `@id:${h.extensionId}`).join(' '))
    } else if (choice === "Don't Ask Again") {
      await context.globalState.update(DONT_ASK_KEY, true)
    }
  }
  return installed
}

/** On activation: install missing defaults shortly after startup, without holding activation up. */
export function autoInstallDefaultHarnesses(context: vscode.ExtensionContext, log: (m: string) => void): vscode.Disposable {
  // Never reach out to the Marketplace from the extension's own test runs.
  if (context.extensionMode === vscode.ExtensionMode.Test) return { dispose: () => {} }
  const timer = setTimeout(() => void installDefaultHarnesses(context, log).catch((err) => log(String(err))), 5_000)
  return {
    dispose: () => clearTimeout(timer),
  }
}
