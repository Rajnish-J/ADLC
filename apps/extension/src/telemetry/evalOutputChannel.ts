// Phase 6 — the live evaluation log channel.
//
// A single VS Code Output Channel ("SDLC Evaluation Log") shared across every
// per-agent Evaluate / Govern run, plus a durable per-run file sink so the log
// survives the channel being cleared. Created once at registration and injected
// into both command handlers (so they share the same channel and tests can fake
// it). Pure formatting (the `[HH:MM:SS]` stamp) is kept here; the commands decide
// what to log.

import * as vscode from 'vscode'

export const EVAL_LOG_CHANNEL_NAME = 'SDLC Evaluation Log'
/** The channel id `workbench.action.output.show` targets — VS Code derives it from the name. */
export const EVAL_LOG_CHANNEL_ID = EVAL_LOG_CHANNEL_NAME

const LOG_DIR = 'eval-logs'

/** Two-digit zero-pad. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Format a wall-clock `[HH:MM:SS]` stamp for a log line. */
export function stamp(date: Date): string {
  return `[${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}]`
}

/**
 * The minimal surface the commands depend on. Declaring it lets unit tests pass a
 * lightweight fake (capturing lines in an array) instead of a real channel.
 */
export interface EvalLog {
  /** Append a timestamped line to the channel and the run's `.log` file. */
  log(runId: string, message: string): void
  /** Reveal the channel without stealing focus. */
  reveal(): void
}

export class EvalOutputChannel implements EvalLog {
  private readonly channel: vscode.OutputChannel
  private readonly dir: vscode.Uri
  /** Per-run append buffer flushed to disk; keyed by runId. Best-effort, never blocks the UI. */
  private readonly buffers = new Map<string, string[]>()

  constructor(globalStorageUri: vscode.Uri) {
    this.channel = vscode.window.createOutputChannel(EVAL_LOG_CHANNEL_NAME)
    this.dir = vscode.Uri.joinPath(globalStorageUri, LOG_DIR)
  }

  log(runId: string, message: string): void {
    const line = `${stamp(new Date())} ${message}`
    this.channel.appendLine(line)
    void this.persist(runId, line)
  }

  reveal(): void {
    // preserveFocus = true → revealed but not force-focused (AC-3).
    this.channel.show(true)
  }

  /** Append a line to `<globalStorageUri>/eval-logs/<runId>.log`. Best-effort. */
  private async persist(runId: string, line: string): Promise<void> {
    const queue = this.buffers.get(runId) ?? []
    queue.push(line)
    this.buffers.set(runId, queue)
    try {
      await vscode.workspace.fs.createDirectory(this.dir)
      const file = vscode.Uri.joinPath(this.dir, `${sanitize(runId)}.log`)
      let existing: Uint8Array = new Uint8Array()
      try {
        existing = await vscode.workspace.fs.readFile(file)
      } catch {
        /* first write for this run */
      }
      const addition = Buffer.from(line + '\n', 'utf8')
      const next = existing.length ? Buffer.concat([Buffer.from(existing), addition]) : addition
      await vscode.workspace.fs.writeFile(file, next)
    } catch {
      // The on-screen channel already has the line; a failed file flush must not
      // break the run. Swallow — this sink is durability, not correctness.
    }
  }

  dispose(): void {
    this.channel.dispose()
  }
}

/** Keep runIds filesystem-safe (they're UUIDs/slugs today, but be defensive). */
function sanitize(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, '_')
}
