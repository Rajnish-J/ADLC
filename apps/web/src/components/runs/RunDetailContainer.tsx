'use client'

// One run, in full, on its own page: what it worked on and how it went; what it changed and the impact on the
// project (with an AI summary); the memory and context it worked from and the memory it left; where its time went
// and the tools it called; its steps, gate evaluations and people's feedback; and its live activity log.

import { useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Activity, Brain, FileDiff, LayoutDashboard, ListChecks, Pause, ShieldCheck, Timer } from 'lucide-react'
import type { ProjectDetail, ProjectRunDetail } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import ProjectShell from '@/components/project/ProjectShell'
import { Markdown } from '@/components/common/markdown'
import { useSession } from '@/components/providers/SessionProvider'
import RunActivity from '@/components/work/RunActivity'
import RunEvaluations from '@/components/work/RunEvaluations'
import RunSteps, { runDuration } from '@/components/work/RunSteps'
import { useRunDetail } from '@/hooks/runs/useRunRecords'
import ApprovalPanel from './ApprovalPanel'
import CompareRunsDialog from './CompareRunsDialog'
import ImpactPanel from './ImpactPanel'
import RunChanges from './RunChanges'
import RunFeedbackCard from './RunFeedbackCard'
import RunFlowCard from './RunFlowCard'
import RunHeader from './RunHeader'
import RunInsightCard from './RunInsightCard'
import RunMemoryContext from './RunMemoryContext'
import RunTimelinePanel from './RunTimelinePanel'
import { lineDelta, plural } from './runFormat'

const TABS = ['overview', 'changes', 'memory', 'timeline', 'steps', 'evaluations', 'activity'] as const
type Tab = (typeof TABS)[number]

function Stats({ run }: { run: ProjectRunDetail }) {
  const agentSteps = run.steps.filter((s) => s.kind === 'agent').length
  const items: UI.StatItem[] = [
    {
      label: 'Files changed',
      value: run.filesChanged,
      footer: { title: run.additions + run.deletions ? `${lineDelta(run.additions, run.deletions)} lines` : 'No line counts', description: run.changes?.commits.length ? plural(run.changes.commits.length, 'commit') : 'Against the commit it started from' },
    },
    {
      label: 'Memory',
      value: `${run.memoryUsed} / ${run.memoryWritten}`,
      footer: { title: 'Used / written', description: run.memory.usedLater ? `What it wrote was given to ${plural(run.memory.usedLater, 'later run')}` : 'Items given to and left by the run' },
    },
    {
      label: 'Gates',
      value: run.gatesPassed + run.gatesFailed ? `${run.gatesPassed} / ${run.gatesPassed + run.gatesFailed}` : '—',
      badge: run.gatesFailed ? { label: `${run.gatesFailed} failed`, variant: 'destructive' } : undefined,
      footer: { title: run.gatesPassed + run.gatesFailed ? 'Passed / evaluated' : 'No gates in this workflow', description: `${run.feedback.up} 👍 · ${run.feedback.down} 👎 from people` },
    },
    {
      label: 'Duration',
      value: runDuration(run.startedAt, run.finishedAt),
      footer: { title: plural(run.stepCount, 'step'), description: `${plural(agentSteps, 'agent step')}${run.agentsUsed.length ? ` · ${run.agentsUsed.join(', ')}` : ''}` },
    },
  ]
  return <UI.StatCards items={items} />
}

function AgentSummary({ run }: { run: ProjectRunDetail }) {
  const last = [...run.steps].filter((s) => s.kind === 'agent' && s.output?.trim()).sort((a, b) => b.seq - a.seq)[0]
  if (!last?.output) return null
  return (
    <UI.Card className="gap-3">
      <UI.CardHeader>
        <UI.CardTitle className="text-base">What the agent says it did</UI.CardTitle>
        <UI.CardDescription>
          {last.label}
          {last.agentName ? ` · ${last.agentName}` : ''} — its own report when it finished the step
        </UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>
        <Markdown source={last.output} className="max-h-96 overflow-y-auto text-sm" />
      </UI.CardContent>
    </UI.Card>
  )
}

function Detail({ project, runId }: { project: ProjectDetail; runId: string }) {
  const { data: run, error, loading, reload } = useRunDetail(project.key, runId)
  const { me } = useSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const requested = params.get('tab')
  const tab: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : 'overview'
  const setTab = (next: string) => router.replace(next === 'overview' ? pathname : `${pathname}?tab=${next}`, { scroll: false })
  const [comparing, setComparing] = useState(false)

  if (error) return <UI.ErrorAlert title={error.status === 404 ? 'Run not found' : 'Could not load the run'} message={error.message} />
  if (loading || !run) {
    return (
      <div className="flex flex-col gap-4">
        <UI.Skeleton className="h-24 rounded-xl" />
        <UI.Skeleton className="h-36 rounded-xl" />
        <UI.Skeleton className="h-96 rounded-xl" />
      </div>
    )
  }

  // Same rule as the API: the run's own user, or anyone who may assign stories (a lead).
  const canDecide = Boolean(me && run.startedBy && run.startedBy.id === me.user.id) || project.permissions.includes('story.assign')
  const evaluationCount = run.steps.reduce((n, s) => n + s.evaluations.length, 0)

  return (
    <div className="flex flex-col gap-5">
      <RunHeader projectKey={project.key} run={run} onCompare={() => setComparing(true)} />

      {run.pendingApproval && run.driver === 'orchestrator' ? (
        <ApprovalPanel
          key={`${run.id}:${run.pendingApproval.stepId}`}
          projectKey={project.key}
          run={run}
          pending={run.pendingApproval}
          canDecide={canDecide}
          onDecided={() => void reload()}
        />
      ) : run.pendingApproval ? (
        <UI.Alert>
          <Pause />
          <UI.AlertTitle>Waiting for approval</UI.AlertTitle>
          <UI.AlertDescription>{run.pendingApproval.question} — decided in VS Code.</UI.AlertDescription>
        </UI.Alert>
      ) : null}
      {run.error ? <UI.ErrorAlert title={run.status === 'expired' ? 'Not started' : 'Run failed'} message={run.error} /> : null}

      <UI.Tabs value={tab} onValueChange={setTab} className="gap-4">
        <UI.ScrollArea className="w-full">
          <UI.TabsList>
            <UI.TabsTrigger value="overview">
              <LayoutDashboard /> Overview
            </UI.TabsTrigger>
            <UI.TabsTrigger value="changes">
              <FileDiff /> Changes ({run.filesChanged})
            </UI.TabsTrigger>
            <UI.TabsTrigger value="memory">
              <Brain /> Memory &amp; context
            </UI.TabsTrigger>
            <UI.TabsTrigger value="timeline">
              <Timer /> Timeline &amp; tools
            </UI.TabsTrigger>
            <UI.TabsTrigger value="steps">
              <ListChecks /> Steps ({run.steps.length})
            </UI.TabsTrigger>
            <UI.TabsTrigger value="evaluations">
              <ShieldCheck /> Evaluations ({evaluationCount + run.feedbackEntries.length})
            </UI.TabsTrigger>
            <UI.TabsTrigger value="activity">
              <Activity /> Activity
            </UI.TabsTrigger>
          </UI.TabsList>
          <UI.ScrollBar orientation="horizontal" />
        </UI.ScrollArea>

        <UI.TabsContent value="overview" className="flex flex-col gap-4">
          <RunFlowCard projectKey={project.key} runId={run.id} />
          <Stats run={run} />
          <div className="grid gap-4 @5xl/main:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <RunInsightCard projectKey={project.key} run={run} />
            <AgentSummary run={run} />
          </div>
          <ImpactPanel files={run.changes?.files ?? null} fallbackPaths={run.changedFiles} />
        </UI.TabsContent>
        <UI.TabsContent value="changes">
          <RunChanges projectKey={project.key} run={run} />
        </UI.TabsContent>
        <UI.TabsContent value="memory">
          <RunMemoryContext projectKey={project.key} run={run} onChanged={() => void reload()} />
        </UI.TabsContent>
        <UI.TabsContent value="timeline">
          <RunTimelinePanel projectKey={project.key} run={run} />
        </UI.TabsContent>
        <UI.TabsContent value="steps">
          <RunSteps steps={run.steps} />
        </UI.TabsContent>
        <UI.TabsContent value="evaluations" className="flex flex-col gap-4">
          <RunFeedbackCard projectKey={project.key} run={run} />
          <RunEvaluations steps={run.steps} />
        </UI.TabsContent>
        <UI.TabsContent value="activity">
          <RunActivity projectKey={project.key} runId={run.id} steps={run.steps} />
        </UI.TabsContent>
      </UI.Tabs>

      {run.attempt?.previousId ? <CompareRunsDialog projectKey={project.key} run={run} open={comparing} onOpenChange={setComparing} /> : null}
    </div>
  )
}

export default function RunDetailContainer() {
  const { runId } = useParams<{ runId: string }>()
  return <ProjectShell header={false}>{(project) => <Detail project={project} runId={decodeURIComponent(runId)} />}</ProjectShell>
}
