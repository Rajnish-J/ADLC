// Harnesses installed in this VS Code window (Copilot, Claude Code, Codex, Roo Code, …) and how to drive each one:
// where its MCP config lives so it can reach the SDLC tools, its hooks (for live activity), and how to open it with
// a prompt. Only installed, enabled harnesses are ever reported or offered. Users can add more in
// `sdlcGovernance.harnesses.custom` (they run at the `files` tier: checkpoints through files, prompt copied).

import * as vscode from 'vscode'
import { KNOWN_HARNESSES, knownHarness, type HarnessTier, type InstalledEngine } from '@sdlc/contracts'

export interface CustomHarness {
  id: string
  label: string
  extensionId: string
  /** A command that opens the harness's chat (optional). */
  openCommand?: string
}

export interface Harness {
  id: string
  label: string
  extensionId: string
  version: string | null
  tier: HarnessTier
  /** Opens the harness's chat. */
  openCommand?: string
}

/** One file the session writes for the harness; JSON files are merged into what is there. */
export interface WiringFile {
  /** Workspace-relative path. */
  path: string
  kind: 'json-merge' | 'text' | 'toml-section'
  /** For json-merge: the object to deep-merge in; for text: the content; for toml-section: the section text. */
  content: unknown
  /** For toml-section: the `[header]` it replaces. */
  section?: string
}

export interface WiringInput {
  mcpUrl: string
  hookUrl: string
}

function customHarnesses(): CustomHarness[] {
  const raw = vscode.workspace.getConfiguration('sdlcGovernance').get<unknown[]>('harnesses.custom', [])
  return (Array.isArray(raw) ? raw : []).flatMap((h) => {
    const c = h as Partial<CustomHarness>
    return c && typeof c.id === 'string' && typeof c.extensionId === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(c.id)
      ? [{ id: c.id, label: c.label ?? c.id, extensionId: c.extensionId, openCommand: c.openCommand }]
      : []
  })
}

function versionOf(ext: vscode.Extension<unknown>): string | null {
  return String((ext.packageJSON as { version?: string }).version ?? '') || null
}

/** Every harness installed and enabled in this window. */
export function installed(): Harness[] {
  const out: Harness[] = []
  for (const h of KNOWN_HARNESSES) {
    for (const id of h.extensionIds) {
      const ext = vscode.extensions.getExtension(id)
      if (ext) {
        out.push({ id: h.id, label: h.label, extensionId: id, version: versionOf(ext), tier: h.tier })
        break
      }
    }
  }
  for (const c of customHarnesses()) {
    if (out.some((h) => h.id === c.id)) continue
    const ext = vscode.extensions.getExtension(c.extensionId)
    if (ext) out.push({ id: c.id, label: c.label, extensionId: c.extensionId, version: versionOf(ext), tier: 'files', openCommand: c.openCommand })
  }
  return out
}

/** For presence: the installed harnesses, as the platform stores them. */
export function installedHarnesses(): InstalledEngine[] {
  return installed().map((h) => ({ engine: h.id, installed: true, version: h.version, label: h.label, extensionId: h.extensionId, tier: h.tier }))
}

export function findHarness(id: string): Harness | undefined {
  return installed().find((h) => h.id === id)
}

/** For the workflow editors: every harness an agent step can be pinned to — the known ones, and custom ones installed here. */
export function harnessOptions(): Array<{ id: string; label: string; installed: boolean }> {
  const here = installed()
  const ids = new Set(here.map((h) => h.id))
  return [
    ...KNOWN_HARNESSES.map((h) => ({ id: h.id, label: h.label, installed: ids.has(h.id) })),
    ...here.filter((h) => !knownHarness(h.id)).map((h) => ({ id: h.id, label: h.label, installed: true })),
  ]
}

// ─── Wiring: MCP and hooks per harness ──────────────────────────────────────────────────────────

/** A hook command that forwards the hook's JSON (stdin) to the bridge and never blocks the harness. */
function hookCommand(url: string): string {
  return `curl -s -m 2 -X POST -H "content-type: application/json" --data-binary @- "${url}"`
}

const CLAUDE_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop']

/** The config files that connect a harness to this run's SDLC tools (and hooks, where the harness has them). */
export function wiringFor(harness: Harness, w: WiringInput): WiringFile[] {
  switch (harness.id) {
    case 'claude-code':
      return [
        { path: '.mcp.json', kind: 'json-merge', content: { mcpServers: { sdlc: { type: 'http', url: w.mcpUrl } } } },
        {
          path: '.claude/settings.local.json',
          kind: 'json-merge',
          content: {
            enabledMcpjsonServers: ['sdlc'],
            hooks: Object.fromEntries(
              CLAUDE_HOOK_EVENTS.map((e) => [e, [{ matcher: e.endsWith('ToolUse') ? '*' : undefined, hooks: [{ type: 'command', command: hookCommand(w.hookUrl), timeout: 5 }] }]]),
            ),
          },
        },
      ]
    case 'copilot':
      return [{ path: '.vscode/mcp.json', kind: 'json-merge', content: { servers: { sdlc: { type: 'http', url: w.mcpUrl } } } }]
    case 'codex':
      return [{ path: '.codex/config.toml', kind: 'toml-section', section: '[mcp_servers.sdlc]', content: `[mcp_servers.sdlc]\nurl = "${w.mcpUrl}"\n` }]
    case 'roo-code':
      return [{ path: '.roo/mcp.json', kind: 'json-merge', content: { mcpServers: { sdlc: { type: 'streamable-http', url: w.mcpUrl } } } }]
    case 'kilo-code':
      return [{ path: '.kilocode/mcp.json', kind: 'json-merge', content: { mcpServers: { sdlc: { type: 'streamable-http', url: w.mcpUrl } } } }]
    default:
      return []
  }
}

/**
 * Whether the harness reports the files it touches through hooks (wired above). Others — Copilot has the SDLC tools
 * (`full` tier) but no hooks — get their files from a file watcher while a step executes.
 */
export function reportsFilesViaHooks(harness: Pick<Harness, 'id'>, tier: HarnessTier): boolean {
  return tier === 'full' && harness.id === 'claude-code'
}

/** Where a harness looks for skills in the workspace (others get them under the session folder). */
export function skillsDirFor(harness: Harness): string | undefined {
  return harness.id === 'claude-code' ? '.claude/skills' : undefined
}

// ─── Opening the harness ────────────────────────────────────────────────────────────────────────

/** Opens the harness with the prompt. Returns true when the prompt was submitted for the user. */
export async function launch(harness: Harness, prompt: string): Promise<{ submitted: boolean; copied: boolean }> {
  switch (harness.id) {
    case 'copilot':
      try {
        await vscode.commands.executeCommand('workbench.action.chat.newChat')
      } catch {
        /* older builds: open reuses the current chat */
      }
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, mode: 'agent', isPartialQuery: false })
      return { submitted: true, copied: false }
    case 'claude-code':
      try {
        await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', undefined, prompt)
      } catch {
        await vscode.env.openExternal(vscode.Uri.parse('vscode://anthropic.claude-code/open?prompt=' + encodeURIComponent(prompt)))
      }
      return { submitted: false, copied: false }
    default: {
      await vscode.env.clipboard.writeText(prompt)
      await reveal(harness)
      return { submitted: false, copied: true }
    }
  }
}

/** Best effort: focus the harness's view (its command ids are not documented and vary by version). */
async function reveal(harness: Harness): Promise<void> {
  if (harness.openCommand) {
    try {
      await vscode.commands.executeCommand(harness.openCommand)
      return
    } catch {
      /* fall through to discovery */
    }
  }
  const name = harness.extensionId.split('.').pop()?.toLowerCase() ?? harness.id
  const all = await vscode.commands.getCommands(true)
  const words = [harness.id.replace(/-/g, ''), name, harness.id === 'codex' ? 'chatgpt' : name, harness.id === 'roo-code' ? 'roo-cline' : name]
  const cmd = all.find((id) => words.some((w) => id.toLowerCase().includes(w)) && /sidebar|focus|open|newtask|plusbutton/i.test(id))
  if (cmd) {
    try {
      await vscode.commands.executeCommand(cmd)
    } catch {
      /* the prompt is on the clipboard either way */
    }
  }
}
