'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Copy, Eye, MoreHorizontal, Pencil, Play, PlayCircle, Plus, ShieldCheck, Star, Trash2, UserCheck, Workflow as WorkflowIcon, SlidersHorizontal } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import * as C from '@/imports/catalog.imports'
import RunsTab from '@/components/runs/RunsTab'
import { QUICK_RUN_EVENT, runHref } from '@/components/work/RunComposerProvider'

/** Make default, duplicate and delete for the selected workflow (leads and owners). */
function WorkflowMenu({ project, workflow, onChanged }: { project: C.ProjectDetail; workflow: C.WorkflowDetail; onChanged: (selectId: string | null) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const base = `/projects/${encodeURIComponent(project.key)}/workflow`

  async function run(action: () => Promise<unknown>, done: string, selectId: string | null): Promise<void> {
    setBusy(true)
    try {
      await action()
      UI.toast.success(done)
      onChanged(selectId)
    } catch (err) {
      UI.toast.error(err instanceof C.AppError ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
      setConfirmDelete(false)
    }
  }

  return (
    <>
      <UI.DropdownMenu>
        <UI.DropdownMenuTrigger asChild>
          <UI.Button variant="outline" size="icon-sm" aria-label="More workflow actions" disabled={busy}>
            {busy ? <UI.Spinner /> : <MoreHorizontal />}
          </UI.Button>
        </UI.DropdownMenuTrigger>
        <UI.DropdownMenuContent align="end" className="min-w-44">
          <UI.DropdownMenuItem asChild>
            <Link href={`${base}/new?from=${workflow.id}`}>
              <Copy /> Duplicate
            </Link>
          </UI.DropdownMenuItem>
          {!workflow.isDefault ? (
            <UI.DropdownMenuItem onSelect={() => void run(() => C.setDefaultWorkflow(project.key, workflow.id), `${workflow.name} is now the default workflow`, workflow.id)}>
              <Star /> Make default
            </UI.DropdownMenuItem>
          ) : null}
          <UI.DropdownMenuSeparator />
          <UI.DropdownMenuItem
            variant="destructive"
            disabled={workflow.isDefault}
            title={workflow.isDefault ? 'Make another workflow the default first' : undefined}
            onSelect={() => setConfirmDelete(true)}
          >
            <Trash2 /> Delete…
          </UI.DropdownMenuItem>
        </UI.DropdownMenuContent>
      </UI.DropdownMenu>
      <UI.AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <UI.AlertDialogContent>
          <UI.AlertDialogHeader>
            <UI.AlertDialogTitle>Delete {workflow.name}?</UI.AlertDialogTitle>
            <UI.AlertDialogDescription>
              The workflow is removed from the project. Finished runs keep their record of it; a workflow with runs in progress can’t be deleted.
            </UI.AlertDialogDescription>
          </UI.AlertDialogHeader>
          <UI.AlertDialogFooter>
            <UI.AlertDialogCancel disabled={busy}>Cancel</UI.AlertDialogCancel>
            <UI.AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                void run(() => C.deleteWorkflow(project.key, workflow.id), `${workflow.name} deleted`, null)
              }}
            >
              Delete workflow
            </UI.AlertDialogAction>
          </UI.AlertDialogFooter>
        </UI.AlertDialogContent>
      </UI.AlertDialog>
    </>
  )
}

function Definition({ project, chosen, setChosen }: { project: C.ProjectDetail; chosen: string | null; setChosen: (id: string) => void }) {
  const { data: workflows, error, reload: reloadWorkflows } = C.useWorkflows(project.key)
  // `?workflow=<id>` (e.g. coming back from the editor) selects that workflow.
  const linked = useSearchParams().get('workflow')
  useEffect(() => {
    if (linked && !chosen && workflows?.some((w) => w.id === linked)) setChosen(linked)
  }, [linked, chosen, workflows, setChosen])
  const fallbackId = workflows?.find((w) => w.isDefault)?.id ?? workflows?.[0]?.id ?? null
  const selectedId = (chosen && workflows?.some((w) => w.id === chosen) ? chosen : null) ?? fallbackId
  const { data: workflow, error: workflowError, loading, reload: reloadWorkflow } = C.useWorkflow(project.key, selectedId)
  const canEdit = project.permissions.includes('workflow.edit')
  const editHref = workflow ? `/projects/${encodeURIComponent(project.key)}/workflow/${workflow.id}/edit` : null

  function afterChange(selectId: string | null): void {
    void reloadWorkflows()
    if (selectId) {
      void reloadWorkflow()
      setChosen(selectId)
      return
    }
    // The selected workflow was deleted: show the default (or any other) one.
    const other = workflows?.find((w) => w.id !== workflow?.id && w.isDefault) ?? workflows?.find((w) => w.id !== workflow?.id)
    if (other) setChosen(other.id)
  }

  if (error) return <UI.ErrorAlert message={error.message} />

  const nodes = workflow?.spec.nodes ?? []
  const agentSteps = nodes.filter((n) => n.kind === 'agent').length
  const gates = nodes.filter((n) => n.kind === 'gate').length
  // Agents plan first (and wait for approval) unless the node opts out with `requirePlanApproval: false`.
  const planned = nodes.filter((n) => n.kind === 'agent' && n.data.requirePlanApproval !== false).length
  const approvals = planned + nodes.filter((n) => n.kind === 'approval').length
  const stats: UI.StatItem[] = [
    {
      label: 'Agent steps',
      value: agentSteps,
      footer: { title: planned === agentSteps ? 'Each agent plans, then executes' : `${planned} plan first; ${agentSteps - planned} execute directly` },
    },
    {
      label: 'Human approvals',
      value: approvals,
      badge: { label: 'Mandatory', icon: <UserCheck /> },
      footer: { title: planned > 0 ? `${planned} plan${planned === 1 ? '' : 's'} + ${approvals - planned} approval step${approvals - planned === 1 ? '' : 's'}` : 'Approval steps only' },
    },
    { label: 'Governance gates', value: gates, badge: { label: 'Foundry', icon: <ShieldCheck />, variant: 'success' }, footer: { title: 'Evaluated between steps; failures stop the run' } },
    { label: 'Total nodes', value: nodes.length, footer: { title: workflow ? `Version ${workflow.version}` : '—' } },
  ]

  return (
    <>
      {workflows && workflows.length > 1 ? (
        <UI.ToggleGroup
          type="single"
          variant="outline"
          value={selectedId ?? undefined}
          onValueChange={(v) => v && setChosen(v)}
          className="flex-wrap"
          aria-label="Workflow"
        >
          {workflows.map((w) => (
            <UI.ToggleGroupItem key={w.id} value={w.id} className="px-3">
              {w.name}
              {w.isDefault ? (
                <UI.Badge variant="secondary" className="ml-1">
                  Default
                </UI.Badge>
              ) : null}
            </UI.ToggleGroupItem>
          ))}
        </UI.ToggleGroup>
      ) : null}

      {loading && !workflow ? <UI.Skeleton className="h-36 rounded-xl" /> : <UI.StatCards items={stats} />}
      {workflowError ? <UI.ErrorAlert message={workflowError.message} /> : null}

      <UI.Card className="gap-0 overflow-hidden py-0">
        <UI.CardHeader className="border-b py-4">
          <UI.CardTitle>{workflow?.name ?? 'Workflow'}</UI.CardTitle>
          <UI.CardDescription>
            {workflow?.description || 'Every story runs through the project’s default workflow.'}
          </UI.CardDescription>
          <UI.CardAction className="flex items-center gap-3">
            <span className="hidden flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground @5xl/main:flex">
              {(['trigger', 'agent', 'gate', 'approval', 'end'] as const).map((k) => (
                <span key={k} className="inline-flex items-center gap-1.5">
                  <span className={UI.cn('size-2 rounded-sm', C.KIND_STYLE[k].swatch)} aria-hidden />
                  {C.KIND_STYLE[k].label}
                </span>
              ))}
            </span>
            {editHref && workflow ? (
              <span className="flex items-center gap-1.5">
                <UI.Button variant={canEdit ? 'default' : 'outline'} size="sm" asChild>
                  <Link href={editHref}>
                    {canEdit ? <Pencil /> : <Eye />} {canEdit ? 'Edit' : 'Open in editor'}
                  </Link>
                </UI.Button>
                {canEdit ? <WorkflowMenu project={project} workflow={workflow} onChanged={afterChange} /> : null}
              </span>
            ) : null}
          </UI.CardAction>
        </UI.CardHeader>
        {loading || !workflow ? <UI.Skeleton className="h-[440px] rounded-none" /> : <C.WorkflowCanvas spec={workflow.spec} />}
      </UI.Card>

      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <SlidersHorizontal className="size-4" />
        Which agent, skills and harness run each step, and the project’s harnesses and memory, are in{' '}
        <Link href={`/projects/${encodeURIComponent(project.key)}/settings/agents`} className="font-medium text-primary hover:underline">
          Project settings
        </Link>
        .
      </p>
    </>
  )
}

/**
 * The workflow itself (definition, agent and skill mapping), and — on the Runs tab — starting a run in your VS Code
 * harness and every run by everyone, each with its own page. `?tab=runs&compose=1` (Quick run, Ctrl/⌘+K) opens the
 * Runs tab with the composer focused; `?prompt=&story=&task=&workflow=&harness=` prefill it (Run again).
 */
function Workflows({ project }: { project: C.ProjectDetail }) {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const linkedRun = params.get('run')
  const wantsRuns = params.get('tab') === 'runs' || params.has('compose') || params.has('file')
  const [tab, setTabState] = useState(wantsRuns ? 'runs' : 'definition')
  const [chosen, setChosen] = useState<string | null>(null)
  const [focus, setFocus] = useState(params.has('compose') ? 1 : 0)

  // Older links (`?run=<id>`) open the run's own page.
  useEffect(() => {
    if (linkedRun) router.replace(runHref(project.key, linkedRun))
  }, [linkedRun, project.key, router])
  useEffect(() => {
    if (wantsRuns) setTabState('runs')
  }, [wantsRuns, params])
  // Quick run while already on this page: back to the composer.
  useEffect(() => {
    const onQuickRun = () => {
      setTabState('runs')
      setFocus((n) => n + 1)
    }
    window.addEventListener(QUICK_RUN_EVENT, onQuickRun)
    return () => window.removeEventListener(QUICK_RUN_EVENT, onQuickRun)
  }, [])

  const setTab = (next: string) => {
    setTabState(next)
    router.replace(next === 'definition' ? pathname : `${pathname}?tab=${next}`, { scroll: false })
  }
  const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null)
  const defaults = {
    prompt: params.get('prompt') ?? undefined,
    storyNumber: num(params.get('story')),
    taskNumber: num(params.get('task')),
    // A `?workflow=` link picks the workflow; the one open on the Definition tab is only a suggestion for a prompt
    // (a story picked with # runs the project default unless a workflow chip is chosen).
    workflowId: params.get('workflow'),
    suggestedWorkflowId: chosen,
    harness: params.get('harness'),
  }

  return (
    <UI.Tabs value={tab} onValueChange={setTab} className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <UI.TabsList>
          <UI.TabsTrigger value="definition">
            <WorkflowIcon /> Definition
          </UI.TabsTrigger>
          <UI.TabsTrigger value="runs">
            <PlayCircle /> Runs &amp; evaluations
          </UI.TabsTrigger>
        </UI.TabsList>
        <UI.Button
          onClick={() => {
            setTab('runs')
            setFocus((n) => n + 1)
          }}
        >
          <Play /> Start in VS Code
        </UI.Button>
      </div>
      <UI.TabsContent value="definition" className="flex flex-col gap-4">
        <Definition project={project} chosen={chosen} setChosen={setChosen} />
      </UI.TabsContent>
      <UI.TabsContent value="runs">
        <RunsTab project={project} defaults={defaults} focus={focus} initialFile={params.get('file') ?? undefined} />
      </UI.TabsContent>
    </UI.Tabs>
  )
}

export default function WorkflowContainer() {
  return (
    <C.ProjectShell
      title="Workflow"
      description="The workflow every story and task runs through, which agent and skills run each step, starting it in your VS Code harness, and every run with its evaluations."
      actions={(project) =>
        project.permissions.includes('workflow.edit') ? (
          <>
            <C.CreateWithAiButton agent="workflows" projectKey={project.key} label="Design with AI" />
            <UI.Button variant="outline" asChild>
              <Link href={`/projects/${encodeURIComponent(project.key)}/workflow/new`}>
                <Plus /> New workflow
              </Link>
            </UI.Button>
          </>
        ) : null
      }
    >
      {(project) => (
        <Suspense fallback={<UI.Skeleton className="h-96 rounded-xl" />}>
          <Workflows project={project} />
        </Suspense>
      )}
    </C.ProjectShell>
  )
}
