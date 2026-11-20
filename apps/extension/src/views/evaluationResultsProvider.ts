// Phase 3 — the Evaluation Results tree.
//
// Surfaces per-step evaluator scores, pass/fail, and the gate decision — read
// from the append-only audit store so results survive reloads. Groups the audit
// log by run: each run shows its gate verdict (✓/✕), expands to its evaluators
// (score vs threshold), and offers a link to the full Foundry report.

import * as vscode from 'vscode'
import type { AuditStore } from '../audit/auditStore'
import type { AuditRecord } from '../audit/auditRecord'
import { STEP_LABELS } from '../eval/sdlcSteps'

type Node = RunNode | EvaluatorNode | DetailNode | MessageNode

const MAX_RUNS = 50

interface RunGroup {
  runId: string
  step: string
  timestamp: string
  gateDecision: 'pass' | 'fail'
  gateReason?: string
  reportUrl?: string
  records: AuditRecord[]
}

/** Label a run group: governance runs read "Governance"; SDLC runs use the step label (W-5). */
function runLabel(group: RunGroup): string {
  if (group.step === 'governance') return 'Governance'
  return STEP_LABELS[group.step as keyof typeof STEP_LABELS] ?? group.step
}

class RunNode extends vscode.TreeItem {
  constructor(
    public readonly group: RunGroup,
    expanded = false,
  ) {
    super(
      runLabel(group),
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    )
    const pass = group.gateDecision === 'pass'
    this.description = `${pass ? 'PASS' : 'FAIL'} · ${new Date(group.timestamp).toLocaleString()}`
    this.tooltip = group.gateReason ?? group.gateDecision
    this.iconPath = new vscode.ThemeIcon(
      pass ? 'pass' : 'error',
      new vscode.ThemeColor(pass ? 'testing.iconPassed' : 'testing.iconFailed'),
    )
    this.contextValue = 'evalRun'
  }
}

class EvaluatorNode extends vscode.TreeItem {
  constructor(record: AuditRecord) {
    // For governance runs the evaluator field already carries the criterion name
    // (e.g. "PII detection (heuristic)"); for SDLC runs it's the evaluator ref.
    super(record.evaluator, vscode.TreeItemCollapsibleState.None)
    const scoreText = record.score === null ? '—' : record.score.toFixed(2)
    const thrText = record.threshold === null ? 'n/a' : String(record.threshold)
    this.description = `${scoreText} / ${thrText} · ${record.pass ? 'pass' : 'fail'}`
    this.iconPath = new vscode.ThemeIcon(record.pass ? 'check' : 'x')
  }
}

class DetailNode extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.description = value
    this.tooltip = value
    this.iconPath = new vscode.ThemeIcon(icon)
    this.command = command
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(label: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon(icon)
  }
}

function groupRuns(records: AuditRecord[]): RunGroup[] {
  const byRun = new Map<string, RunGroup>()
  // records arrive newest-first; preserve that order for groups.
  for (const r of records) {
    let g = byRun.get(r.runId)
    if (!g) {
      g = {
        runId: r.runId,
        step: r.step,
        timestamp: r.timestamp,
        gateDecision: r.gateDecision,
        gateReason: r.gateReason,
        reportUrl: r.reportUrl,
        records: [],
      }
      byRun.set(r.runId, g)
    }
    g.records.push(r)
  }
  return [...byRun.values()]
}

export class EvaluationResultsProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private groups: RunGroup[] | undefined
  /** Run to auto-expand on the next render (the run just completed). */
  private latestRunId: string | undefined

  constructor(private readonly store: AuditStore) {}

  /** Invalidate the cache and re-render. Pass the just-completed runId to auto-expand it (W-5). */
  refresh(latestRunId?: string): void {
    this.groups = undefined
    this.latestRunId = latestRunId
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (element instanceof RunNode) {
      const g = element.group
      const children: Node[] = g.records.map((r) => new EvaluatorNode(r))
      if (g.reportUrl) {
        children.push(
          new DetailNode('Open full report', g.reportUrl, 'link-external', {
            command: 'vscode.open',
            title: 'Open report',
            arguments: [vscode.Uri.parse(g.reportUrl)],
          }),
        )
      }
      // Always offer a jump to the live log channel for this run (AC-4).
      children.push(
        new DetailNode('View run log', '', 'output', {
          command: 'sdlcGovernance.showEvalLog',
          title: 'View run log',
        }),
      )
      return children
    }
    if (element) {
      return []
    }

    if (this.groups === undefined) {
      const records = await this.store.readRecent(MAX_RUNS * 6)
      this.groups = groupRuns(records).slice(0, MAX_RUNS)
    }
    if (this.groups.length === 0) {
      return [new MessageNode('No evaluations yet. Run “Govern & Evaluate”.', 'info')]
    }
    return this.groups.map((g) => new RunNode(g, g.runId === this.latestRunId))
  }
}
