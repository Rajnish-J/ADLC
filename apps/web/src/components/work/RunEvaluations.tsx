'use client'

// Every evaluator verdict of a run, gate by gate: score against threshold, pass/fail, required or advisory, the
// evaluator's reason, dataset counts, judge tokens and where the score came from.

import { ExternalLink, ShieldCheck } from 'lucide-react'
import type { StoryRunStep } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'

const fmt = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(2))

export default function RunEvaluations({ steps }: { steps: StoryRunStep[] }) {
  const gates = steps.filter((s) => s.evaluations.length > 0 || s.gatePass !== null)
  if (gates.length === 0) {
    return <UI.EmptyState icon={<ShieldCheck />} title="No evaluations yet" description="Gate evaluations appear here as soon as a gate runs." />
  }
  const all = gates.flatMap((s) => s.evaluations)
  const passed = all.filter((e) => e.pass).length
  const judgeTokens = all.reduce((n, e) => n + (e.tokensIn ?? 0) + (e.tokensOut ?? 0), 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <UI.Badge variant="secondary">{gates.length} gate{gates.length === 1 ? '' : 's'}</UI.Badge>
        <UI.Badge variant={passed === all.length ? 'success' : 'warning'}>
          {passed}/{all.length} evaluators passed
        </UI.Badge>
        {judgeTokens > 0 ? <UI.Badge variant="outline">{judgeTokens.toLocaleString()} judge tokens</UI.Badge> : null}
      </div>
      {gates.map((s) => (
        <section key={s.stepId} className="flex flex-col gap-2">
          <header className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{s.label}</span>
            {s.gatePass !== null ? <UI.Badge variant={s.gatePass ? 'success' : 'destructive'}>{s.gatePass ? 'Gate passed' : 'Gate failed'}</UI.Badge> : null}
            {s.reportUrl ? (
              <a href={s.reportUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">
                Full report <ExternalLink className="size-3" />
              </a>
            ) : null}
          </header>
          {s.gateReason ? <p className="text-xs text-muted-foreground">{s.gateReason}</p> : null}
          {s.evaluations.length ? (
            <div className="overflow-x-auto rounded-md border">
              <UI.Table>
                <UI.TableHeader>
                  <UI.TableRow>
                    <UI.TableHead>Evaluator</UI.TableHead>
                    <UI.TableHead className="text-right">Score</UI.TableHead>
                    <UI.TableHead>Result</UI.TableHead>
                    <UI.TableHead className="text-right">Rows</UI.TableHead>
                    <UI.TableHead className="text-right">Tokens</UI.TableHead>
                  </UI.TableRow>
                </UI.TableHeader>
                <UI.TableBody>
                  {s.evaluations.map((e) => (
                    <UI.TableRow key={e.evaluator} className="align-top">
                      <UI.TableCell className="max-w-56 whitespace-normal">
                        <div className="font-medium">{e.evaluator}</div>
                        {e.reason ? <div className="text-xs text-muted-foreground">{e.reason}</div> : null}
                        {e.source === 'stub' ? <div className="text-xs text-warning-foreground dark:text-warning">Local stub — Foundry not configured</div> : null}
                      </UI.TableCell>
                      <UI.TableCell className="text-right tabular-nums">
                        {fmt(e.score)} / {fmt(e.threshold)}
                      </UI.TableCell>
                      <UI.TableCell>
                        <div className="flex flex-wrap gap-1">
                          <UI.Badge variant={e.pass ? 'success' : 'destructive'}>{e.pass ? 'Pass' : 'Fail'}</UI.Badge>
                          {e.required === false ? <UI.Badge variant="outline">Advisory</UI.Badge> : null}
                        </div>
                      </UI.TableCell>
                      <UI.TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                        {e.counts ? `${e.counts.passed} ✓ ${e.counts.failed} ✗${e.counts.errored ? ` ${e.counts.errored} !` : ''}` : '—'}
                      </UI.TableCell>
                      <UI.TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                        {e.tokensIn || e.tokensOut ? ((e.tokensIn ?? 0) + (e.tokensOut ?? 0)).toLocaleString() : '—'}
                      </UI.TableCell>
                    </UI.TableRow>
                  ))}
                </UI.TableBody>
              </UI.Table>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  )
}
