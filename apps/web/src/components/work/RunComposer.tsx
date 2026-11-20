'use client'

// Run something in your VS Code from one box: type a quick fix ("fix the typo on the checkout button"), or type `#`
// to pick a story (then the text is extra instructions). The harness and workflow are chips with sensible defaults —
// the Quick fix workflow for a prompt, the project default for a story — and the per-step harnesses and the VS Code
// window sit behind Options. Enter runs it: the API records the run, the vscode:// link opens VS Code, and the box
// follows the run until a window has picked it up.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, ExternalLink, Hash, Loader2, Play, Settings2, Workflow, X, XCircle, Zap } from 'lucide-react'
import {
  harnessLabel,
  isHarnessAllowed,
  MissingHarnessesSchema,
  RUN_PROMPT_MAX,
  RUN_STATUS_LABELS,
  sameRepository,
  type MissingHarnesses,
  type ProjectDetail,
  type StartableHarness,
} from '@sdlc/contracts'
import { QUICK_FIX_WORKFLOW_NAME, type SpecNode } from '@sdlc/core'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { useSession } from '@/components/providers/SessionProvider'
import { useWorkflow, useWorkflows } from '@/hooks/catalog/useCatalog'
import { useStories } from '@/hooks/story/useStories'
import { useHarnesses, useStoryTasks } from '@/hooks/work/useHarnessRuns'
import { useProjectRun } from '@/hooks/work/useRuns'
import { cancelRun, requestRun } from '@/service/harnessRun.service'
import { HarnessTierBadge, NoVsCode, windowName } from './HarnessPicker'

export interface RunComposerDefaults {
  storyNumber?: number | null
  taskNumber?: number | null
  workflowId?: string | null
  /**
   * The workflow being looked at (e.g. on the Workflow page): used for a prompt-only run unless a chip is picked, but
   * never for a story — a story runs the project default unless a workflow is chosen for it explicitly.
   */
  suggestedWorkflowId?: string | null
  prompt?: string
  /** The harness to start in (when it's installed and allowed), e.g. to run something again the same way. */
  harness?: string | null
}

interface RunComposerProps {
  project: ProjectDetail
  defaults?: RunComposerDefaults
  /** `inline`: a box on a page (the board); `dialog`: inside the global composer dialog. */
  variant?: 'inline' | 'dialog'
  /** Opens the run's details once VS Code has it. */
  onOpenRun?: (runId: string) => void
  /** Focus the box when it mounts (the dialog). */
  autoFocus?: boolean
}

const NO_TASK = 'story'
const ANY_WINDOW = 'any'

function openDeepLink(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// ─── After Run: follow it until VS Code picks it up ─────────────────────────────────────────────

function RunProgress({
  projectKey,
  runId,
  deepLink,
  sentTo,
  onOpenRun,
  onAnother,
}: {
  projectKey: string
  runId: string
  deepLink: string
  /** The VS Code window (already on the project's repo) the run was sent to, so no link was opened. */
  sentTo: string | null
  onOpenRun?: (id: string) => void
  onAnother: () => void
}) {
  const { data: run } = useProjectRun(projectKey, runId)
  const status = run?.status ?? 'requested'
  const waiting = status === 'requested'
  const failed = status === 'expired' || status === 'cancelled' || status === 'failed'
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-start gap-3 text-sm">
        {waiting ? (
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
        ) : failed ? (
          <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium">
            {waiting
              ? sentTo
                ? `Sent to your VS Code window — ${sentTo}`
                : 'Waiting for VS Code to pick it up…'
              : failed
                ? RUN_STATUS_LABELS[status]
                : `Running in ${harnessLabel(run?.engine ?? '')} — ${RUN_STATUS_LABELS[status].toLowerCase()}`}
          </span>
          {run?.prompt ? <span className="line-clamp-2 text-xs text-muted-foreground">“{run.prompt}”</span> : null}
          <span className="text-xs text-muted-foreground">
            {waiting
              ? sentTo
                ? 'That window already has the project’s repository open, so the run starts there in a moment — no new window. If it doesn’t, open VS Code from here.'
                : 'Your browser asked to open VS Code. If nothing happened, open it again; the extension also picks the run up by itself while it is connected.'
              : failed
                ? (run?.error ?? 'The run did not start.')
                : 'Follow its steps, agents and evaluations live in the run’s details.'}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {waiting ? (
          <>
            <UI.Button variant="outline" size="sm" onClick={() => openDeepLink(deepLink)}>
              <ExternalLink /> {sentTo ? 'Open VS Code' : 'Open VS Code again'}
            </UI.Button>
            <UI.Button
              variant="ghost"
              size="sm"
              onClick={() => cancelRun(projectKey, runId).catch((e) => UI.toast.error(e instanceof AppError ? e.message : 'Could not cancel'))}
            >
              Cancel
            </UI.Button>
          </>
        ) : null}
        {!waiting && onOpenRun ? (
          <UI.Button size="sm" onClick={() => onOpenRun(runId)}>
            View run details
          </UI.Button>
        ) : null}
        <UI.Button variant="ghost" size="sm" className="ml-auto" onClick={onAnother}>
          Run something else
        </UI.Button>
      </div>
    </div>
  )
}

// ─── Options: where each step runs, and which window ─────────────────────────────────────────────

/** Each agent step and the harness it runs in: its pinned one, or the one picked on the chip. */
function StepHarnesses({
  steps,
  picked,
  startable,
  allowed,
  missing,
}: {
  steps: SpecNode[]
  picked: string | null
  startable: StartableHarness[]
  allowed: string[]
  missing: Set<string>
}) {
  if (steps.length === 0) return <p className="text-xs text-muted-foreground">This workflow has no agent steps.</p>
  return (
    <ul className="flex flex-col divide-y rounded-md border text-sm">
      {steps.map((step) => {
        const pinned = step.data.harness
        const problem =
          pinned && (missing.has(step.id) || !startable.some((h) => h.engine === pinned))
            ? isHarnessAllowed(pinned, allowed)
              ? 'Not installed in your VS Code'
              : 'Not allowed in this project'
            : null
        return (
          <li key={step.id} className="flex items-center gap-2 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 truncate">{step.label}</span>
            {problem ? (
              <UI.Tooltip>
                <UI.TooltipTrigger asChild>
                  <AlertTriangle className="size-3.5 text-warning-foreground dark:text-warning" aria-label={problem} />
                </UI.TooltipTrigger>
                <UI.TooltipContent>{problem}</UI.TooltipContent>
              </UI.Tooltip>
            ) : null}
            <UI.Badge variant={pinned ? (problem ? 'warning' : 'secondary') : 'outline'}>
              {pinned ? harnessLabel(pinned) : picked ? harnessLabel(picked) : 'No harness'}
            </UI.Badge>
          </li>
        )
      })}
    </ul>
  )
}

/** The API refused to start: these steps are pinned to harnesses not installed in your online VS Code windows. */
function MissingHarnessesAlert({ missing, labels }: { missing: MissingHarnesses['missing']; labels: Map<string, string> }) {
  return (
    <UI.Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
      <AlertTriangle />
      <UI.AlertTitle>Some steps need a harness you don’t have</UI.AlertTitle>
      <UI.AlertDescription>
        <ul className="flex flex-col gap-0.5">
          {missing.map((m) => (
            <li key={m.engine}>
              <span className="font-medium">{m.label || harnessLabel(m.engine)}</span>: {m.nodeIds.map((id) => labels.get(id) ?? id).join(', ')}
            </li>
          ))}
        </ul>
        <p className="mt-1">Install it in VS Code and keep that window open, or change the step’s harness on the Workflow page.</p>
      </UI.AlertDescription>
    </UI.Alert>
  )
}

/** A small pill-shaped control in the composer's footer. */
const CHIP = 'h-7 gap-1.5 rounded-full px-2.5 text-xs font-normal'

// ─── The composer ────────────────────────────────────────────────────────────────────────────────

export default function RunComposer({ project, defaults, variant = 'inline', onOpenRun, autoFocus }: RunComposerProps) {
  const { me } = useSession()
  const { data: stories } = useStories(project.key)
  const { data: workflows } = useWorkflows(project.key)
  const harnesses = useHarnesses(project.settings)
  const textRef = useRef<HTMLTextAreaElement>(null)

  const [text, setText] = useState(defaults?.prompt ?? '')
  const [storyNumber, setStoryNumber] = useState<number | null>(defaults?.storyNumber ?? null)
  const [taskValue, setTaskValue] = useState<string>(defaults?.taskNumber ? String(defaults.taskNumber) : NO_TASK)
  const [workflowId, setWorkflowId] = useState<string | null>(defaults?.workflowId ?? null)
  const [engine, setEngine] = useState<string | null>(defaults?.harness ?? null)
  const [clientId, setClientId] = useState<string>(ANY_WINDOW)
  const [picking, setPicking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [started, setStarted] = useState<{ runId: string; deepLink: string; sentTo: string | null } | null>(null)
  const [missing, setMissing] = useState<{ workflowId: string; items: MissingHarnesses['missing'] } | null>(null)
  const { data: tasks } = useStoryTasks(project.key, storyNumber)

  // New defaults (the dialog reopened for another story or workflow) start over.
  useEffect(() => {
    setText(defaults?.prompt ?? '')
    setStoryNumber(defaults?.storyNumber ?? null)
    setTaskValue(defaults?.taskNumber ? String(defaults.taskNumber) : NO_TASK)
    setWorkflowId(defaults?.workflowId ?? null)
    setEngine(defaults?.harness ?? null)
    setStarted(null)
    setMissing(null)
  }, [defaults?.prompt, defaults?.storyNumber, defaults?.taskNumber, defaults?.workflowId, defaults?.harness])

  const startableStories = useMemo(
    () =>
      (stories ?? [])
        .filter((s) => s.actions.canReportWork && s.status !== 'done')
        .sort((a, b) => Number(b.assignee?.id === me?.user.id) - Number(a.assignee?.id === me?.user.id)),
    [stories, me],
  )
  const story = storyNumber != null ? (stories?.find((s) => s.number === storyNumber) ?? null) : null
  const canQuickFix = project.permissions.includes('code.edit')

  // The workflow: the one picked, else Quick fix for a prompt and the project default for a story.
  const projectDefault = workflows?.find((w) => w.isDefault) ?? workflows?.[0] ?? null
  const quickFix = workflows?.find((w) => w.name === QUICK_FIX_WORKFLOW_NAME) ?? null
  const suggested = workflows?.find((w) => w.id === defaults?.suggestedWorkflowId) ?? null
  const workflow = workflows?.find((w) => w.id === workflowId) ?? (storyNumber == null ? (suggested ?? quickFix ?? projectDefault) : projectDefault)

  const harness = engine && harnesses.startable.some((h) => h.engine === engine) ? engine : harnesses.preferred
  const harnessInfo = harnesses.startable.find((h) => h.engine === harness) ?? null
  const windows = harnesses.clients.filter((c) => harnessInfo?.clientIds.includes(c.clientId))
  // Windows that have this project's repository open: the platform sends the run straight to one of them.
  const repoWindows = new Set(windows.filter((c) => sameRepository(c.workspace?.remoteUrl, project.repoUrl)).map((c) => c.clientId))

  const { data: workflowDetail } = useWorkflow(project.key, workflow?.id ?? null)
  const spec = workflowDetail && workflowDetail.id === workflow?.id ? workflowDetail.spec : null
  const agentSteps = useMemo(() => spec?.nodes.filter((n) => n.kind === 'agent') ?? [], [spec])
  const stepLabels = useMemo(() => new Map((spec?.nodes ?? []).map((n) => [n.id, n.label])), [spec])
  const missingNow = missing && missing.workflowId === workflow?.id ? missing.items : null

  const prompt = text.trim()
  const noVsCode = !harnesses.loading && harnesses.clients.length === 0
  // A story asked for (a link, a stale list) that isn't one you can start: never fall back to a quick fix silently.
  const unavailable =
    storyNumber != null && stories && (!story || !story.actions.canReportWork || story.status === 'done')
      ? !story
        ? `Story #${storyNumber} isn’t in this project’s list — pick another with #.`
        : story.status === 'done'
          ? `${story.key} is done — reopen it before starting a run.`
          : `You can’t start runs on ${story.key} — it isn’t assigned to you.`
      : null
  const blocker = unavailable
    ? unavailable
    : !story && !prompt
    ? null
    : !story && !canQuickFix
      ? 'You can’t change code in this project — pick a story you work on with #.'
      : !workflow
        ? 'This project has no workflow yet.'
        : noVsCode
          ? 'No VS Code window is connected.'
          : !harness
            ? 'No allowed harness is installed in your VS Code.'
            : null
  const ready = (Boolean(story) || Boolean(prompt)) && !blocker && !submitting && (storyNumber == null || Boolean(story))

  function reset() {
    setStarted(null)
    setMissing(null)
    setText('')
    setStoryNumber(null)
    setTaskValue(NO_TASK)
    setWorkflowId(null)
    requestAnimationFrame(() => textRef.current?.focus())
  }

  async function run() {
    if (!ready || !workflow || !harness) return
    setSubmitting(true)
    setMissing(null)
    try {
      const result = await requestRun(project.key, {
        storyNumber: story?.number ?? null,
        taskNumber: story && taskValue !== NO_TASK ? Number(taskValue) : null,
        prompt: prompt || null,
        workflowId: workflow.id,
        engine: harness,
        clientId: clientId === ANY_WINDOW ? null : clientId,
      })
      // Sent to a window already on the repo: its live connection delivers the run. Opening the vscode:// link too
      // would hand it to whichever window was focused last — or open a new one.
      const target = result.delivery === 'window' ? harnesses.clients.find((c) => c.clientId === result.clientId) : undefined
      setStarted({ runId: result.run.id, deepLink: result.deepLink, sentTo: result.delivery === 'window' ? (target ? windowName(target) : 'the one with this repo') : null })
      if (result.delivery !== 'window') openDeepLink(result.deepLink)
    } catch (err) {
      const details = err instanceof AppError && err.code === 'missing_harnesses' ? MissingHarnessesSchema.safeParse(err.details) : null
      if (details?.success) setMissing({ workflowId: workflow.id, items: details.data.missing })
      else UI.toast.error(err instanceof AppError ? err.message : 'Could not start the run')
    } finally {
      setSubmitting(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void run()
    } else if (e.key === 'Backspace' && !text && story) {
      // Backspace in an empty box drops the story, like removing a chip.
      setStoryNumber(null)
      setTaskValue(NO_TASK)
    }
  }

  function onChange(value: string) {
    // A `#` typed at the start or after a space opens the story picker (and is not kept in the text).
    const typedHash = value.length === text.length + 1 && value.endsWith('#') && (value.length === 1 || /\s#$/.test(value))
    if (typedHash && !story) {
      setText(value.slice(0, -1))
      setPicking(true)
      return
    }
    setText(value.slice(0, RUN_PROMPT_MAX))
  }

  function pickStory(number: number) {
    setStoryNumber(number)
    setTaskValue(NO_TASK)
    setPicking(false)
    requestAnimationFrame(() => textRef.current?.focus())
  }

  const placeholder = story
    ? 'Anything to add for this run? (optional)'
    : canQuickFix
      ? 'Describe a quick fix, or type # to pick a story…'
      : 'Type # to pick a story to run…'

  return (
    <div
      className={UI.cn(
        'flex flex-col overflow-hidden bg-card text-card-foreground',
        variant === 'inline' ? 'rounded-xl border shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30' : '',
      )}
    >
      {started ? (
        <RunProgress projectKey={project.key} runId={started.runId} deepLink={started.deepLink} sentTo={started.sentTo} onOpenRun={onOpenRun} onAnother={reset} />
      ) : (
        <>
          {missingNow ? <MissingHarnessesAlert missing={missingNow} labels={stepLabels} /> : null}

          {story ? (
            <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
              <UI.Badge variant="secondary" className="h-6 max-w-full gap-1 pr-1">
                <Hash className="size-3" />
                <span className="truncate">
                  {story.key} · {story.title}
                </span>
                <button
                  type="button"
                  className="rounded-sm p-0.5 hover:bg-foreground/10"
                  aria-label="Remove story"
                  onClick={() => (setStoryNumber(null), setTaskValue(NO_TASK))}
                >
                  <X className="size-3" />
                </button>
              </UI.Badge>
              {(tasks ?? []).some((t) => t.status !== 'done') ? (
                <UI.Select value={taskValue} onValueChange={setTaskValue}>
                  <UI.SelectTrigger size="sm" aria-label="Task" className="h-6 rounded-full text-xs">
                    <UI.SelectValue />
                  </UI.SelectTrigger>
                  <UI.SelectContent>
                    <UI.SelectItem value={NO_TASK}>The whole story</UI.SelectItem>
                    {(tasks ?? [])
                      .filter((t) => t.status !== 'done')
                      .map((t) => (
                        <UI.SelectItem key={t.number} value={String(t.number)}>
                          T{t.number} · {t.title}
                        </UI.SelectItem>
                      ))}
                  </UI.SelectContent>
                </UI.Select>
              ) : null}
            </div>
          ) : null}

          <UI.Popover open={picking} onOpenChange={setPicking}>
            {/* The story picker hangs off the text box; typing `#` (or the Story chip) opens it. */}
            <UI.PopoverAnchor asChild>
              <div>
                <textarea
                  ref={textRef}
                  value={text}
                  onChange={(e) => onChange(e.target.value)}
                  onKeyDown={onKeyDown}
                  autoFocus={autoFocus}
                  rows={variant === 'dialog' ? 3 : 1}
                  maxLength={RUN_PROMPT_MAX}
                  placeholder={placeholder}
                  aria-label="Describe the fix, or pick a story"
                  className={UI.cn(
                    'field-sizing-content max-h-60 w-full resize-none bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground',
                    story ? 'pt-2' : 'pt-3',
                    variant === 'dialog' ? 'min-h-20' : 'min-h-10',
                  )}
                />
              </div>
            </UI.PopoverAnchor>
            <UI.PopoverContent align="start" className="w-[min(28rem,var(--radix-popover-trigger-width))] p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
              <UI.Command>
                <UI.CommandInput placeholder="Find a story…" autoFocus />
                <UI.CommandList>
                  <UI.CommandEmpty>{stories ? 'No stories you can work on.' : 'Loading…'}</UI.CommandEmpty>
                  <UI.CommandGroup heading="Stories you can work on">
                    {startableStories.map((s) => (
                      <UI.CommandItem key={s.number} value={`${s.key} ${s.title}`} onSelect={() => pickStory(s.number)}>
                        <span className="font-mono text-xs text-muted-foreground">{s.key}</span>
                        <span className="truncate">{s.title}</span>
                        {s.assignee?.id === me?.user.id ? <UI.Badge variant="outline" className="ml-auto">Mine</UI.Badge> : null}
                      </UI.CommandItem>
                    ))}
                  </UI.CommandGroup>
                </UI.CommandList>
              </UI.Command>
            </UI.PopoverContent>
          </UI.Popover>

          <div className="flex flex-wrap items-center gap-1.5 px-2 pt-1 pb-2">
            {!story ? (
              <UI.Button type="button" variant="ghost" size="sm" className={CHIP} onClick={() => setPicking(true)}>
                <Hash /> Story
              </UI.Button>
            ) : null}

            {/* Harness */}
            {noVsCode ? (
              <UI.Popover>
                <UI.PopoverTrigger asChild>
                  <UI.Button type="button" variant="outline" size="sm" className={UI.cn(CHIP, 'border-warning text-warning-foreground dark:text-warning')}>
                    <AlertTriangle /> No VS Code
                  </UI.Button>
                </UI.PopoverTrigger>
                <UI.PopoverContent align="start" className="w-80 p-0">
                  <NoVsCode onRetry={() => void harnesses.reload()} />
                </UI.PopoverContent>
              </UI.Popover>
            ) : (
              <UI.DropdownMenu>
                <UI.DropdownMenuTrigger asChild>
                  <UI.Button type="button" variant="outline" size="sm" className={CHIP} disabled={harnesses.loading && !harnessInfo}>
                    <Bot /> {harnessInfo ? harnessInfo.label : harnesses.loading ? 'Harness…' : 'No harness'} <ChevronDown className="opacity-60" />
                  </UI.Button>
                </UI.DropdownMenuTrigger>
                <UI.DropdownMenuContent align="start" className="w-72">
                  <UI.DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Installed in your VS Code</UI.DropdownMenuLabel>
                  {harnesses.startable.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">No allowed harness is installed. Install one this project allows.</p>
                  ) : (
                    harnesses.startable.map((h) => (
                      <UI.DropdownMenuItem key={h.engine} onSelect={() => setEngine(h.engine)} className="gap-2">
                        <Bot className="text-muted-foreground" />
                        <span className={UI.cn('truncate', h.engine === harness && 'font-medium')}>{h.label}</span>
                        {h.version ? <span className="text-xs text-muted-foreground">v{h.version}</span> : null}
                        <span className="ml-auto">
                          <HarnessTierBadge tier={h.tier} />
                        </span>
                      </UI.DropdownMenuItem>
                    ))
                  )}
                </UI.DropdownMenuContent>
              </UI.DropdownMenu>
            )}

            {/* Workflow */}
            <UI.DropdownMenu>
              <UI.DropdownMenuTrigger asChild>
                <UI.Button type="button" variant="outline" size="sm" className={CHIP} disabled={!workflows}>
                  {workflow?.name === QUICK_FIX_WORKFLOW_NAME ? <Zap /> : <Workflow />}
                  <span className="max-w-40 truncate">{workflow?.name ?? 'Workflow…'}</span>
                  <ChevronDown className="opacity-60" />
                </UI.Button>
              </UI.DropdownMenuTrigger>
              <UI.DropdownMenuContent align="start" className="w-64">
                <UI.DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Workflow</UI.DropdownMenuLabel>
                {(workflows ?? []).map((w) => (
                  <UI.DropdownMenuItem key={w.id} onSelect={() => setWorkflowId(w.id)} className="gap-2">
                    {w.name === QUICK_FIX_WORKFLOW_NAME ? <Zap className="text-muted-foreground" /> : <Workflow className="text-muted-foreground" />}
                    <span className={UI.cn('truncate', w.id === workflow?.id && 'font-medium')}>{w.name}</span>
                    {w.isDefault ? <span className="ml-auto text-xs text-muted-foreground">default</span> : null}
                  </UI.DropdownMenuItem>
                ))}
              </UI.DropdownMenuContent>
            </UI.DropdownMenu>

            {/* Options: per-step harnesses and the window */}
            <UI.Popover>
              <UI.Tooltip>
                <UI.TooltipTrigger asChild>
                  <UI.PopoverTrigger asChild>
                    <UI.Button type="button" variant="ghost" size="icon-sm" className="relative size-7 rounded-full" aria-label="Run options">
                      <Settings2 />
                      {missingNow ? <span className="absolute size-1.5 translate-x-2 -translate-y-2 rounded-full bg-destructive" /> : null}
                    </UI.Button>
                  </UI.PopoverTrigger>
                </UI.TooltipTrigger>
                <UI.TooltipContent>Steps and VS Code window</UI.TooltipContent>
              </UI.Tooltip>
              <UI.PopoverContent align="start" className="flex w-80 flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">Steps of {workflow?.name ?? 'the workflow'}</span>
                  <StepHarnesses
                    steps={agentSteps}
                    picked={harness}
                    startable={harnesses.startable}
                    allowed={harnesses.settings.allowedEngines}
                    missing={new Set(missingNow?.flatMap((m) => m.nodeIds) ?? [])}
                  />
                </div>
                {windows.length > 1 ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium">VS Code window</span>
                    <UI.Select value={clientId} onValueChange={setClientId}>
                      <UI.SelectTrigger size="sm" aria-label="VS Code window">
                        <UI.SelectValue />
                      </UI.SelectTrigger>
                      <UI.SelectContent>
                        <UI.SelectItem value={ANY_WINDOW}>{repoWindows.size > 0 ? 'The window with this repo' : 'Whichever opens the link'}</UI.SelectItem>
                        {windows.map((c) => (
                          <UI.SelectItem key={c.clientId} value={c.clientId}>
                            {windowName(c)}
                            {c.workspace?.branch ? ` · ${c.workspace.branch}` : ''}
                            {repoWindows.has(c.clientId) ? ' · has this repo' : ''}
                          </UI.SelectItem>
                        ))}
                      </UI.SelectContent>
                    </UI.Select>
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {story ? 'Runs on the story’s branch.' : 'A quick fix runs on its own new quick/… branch.'} Steps, agents and evaluations are recorded as it goes.
                </p>
              </UI.PopoverContent>
            </UI.Popover>

            <span className="ml-auto flex items-center gap-2">
              {blocker && noVsCode && blocker === 'No VS Code window is connected.' ? (
                // The usual reason Run does nothing: say so where people look, and lead to the fix.
                <Link href="/settings/vscode" className="flex items-center gap-1 text-xs font-medium text-warning-foreground underline-offset-4 hover:underline dark:text-warning">
                  <AlertTriangle className="size-3.5" /> No VS Code connected — connect it
                </Link>
              ) : blocker ? (
                <span className="hidden max-w-64 truncate text-xs text-muted-foreground sm:inline" title={blocker}>
                  {blocker}
                </span>
              ) : (
                <span className="hidden text-xs text-muted-foreground sm:inline">⏎ to run · ⇧⏎ new line</span>
              )}
              <UI.Button type="button" size="sm" className="h-7 rounded-full" onClick={() => void run()} disabled={!ready}>
                {submitting ? <UI.Spinner /> : <Play />} Run
              </UI.Button>
            </span>
          </div>
        </>
      )}
    </div>
  )
}
