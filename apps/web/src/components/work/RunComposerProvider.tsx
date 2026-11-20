'use client'

// Starting runs. Quick run (the sidebar) and Ctrl/⌘+K go to the project's Workflow page, Runs tab, with the
// composer focused — runs are started and followed there, next to every run and its evaluations. Outside a project,
// Ctrl/⌘+K first asks which project. The story page's Start buttons still open the composer in a small dialog,
// prefilled with the story or task, so starting one doesn't leave the story.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { FolderKanban } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import { useCurrentProject } from '@/components/layout/current-project'
import { useProject, useProjects } from '@/hooks/project/useProjects'
import RunComposer, { type RunComposerDefaults } from './RunComposer'

export interface OpenComposerOptions extends RunComposerDefaults {
  /** The project to run in; defaults to the one in the URL. */
  projectKey?: string
  /** Opens the run's details once VS Code has it; defaults to the run's page. */
  onOpenRun?: (runId: string) => void
}

interface RunComposerApi {
  /** The composer in a small dialog, prefilled (the story page's Start buttons). */
  openComposer: (options?: OpenComposerOptions) => void
}

const RunComposerContext = createContext<RunComposerApi | null>(null)

/** Fired on Quick run, so a Workflow page that is already open goes back to its composer. */
export const QUICK_RUN_EVENT = 'sdlc:quick-run'

export function announceQuickRun(): void {
  window.dispatchEvent(new Event(QUICK_RUN_EVENT))
}

/** The Workflow page's Runs tab with the composer focused, prefilled with `defaults`. */
export function quickRunHref(projectKey: string, defaults: RunComposerDefaults = {}): string {
  const params = new URLSearchParams({ tab: 'runs', compose: '1' })
  if (defaults.prompt) params.set('prompt', defaults.prompt)
  if (defaults.storyNumber) params.set('story', String(defaults.storyNumber))
  if (defaults.taskNumber) params.set('task', String(defaults.taskNumber))
  if (defaults.workflowId) params.set('workflow', defaults.workflowId)
  if (defaults.harness) params.set('harness', defaults.harness)
  return `/projects/${encodeURIComponent(projectKey)}/workflow?${params.toString()}`
}

/** A run's own page. */
export function runHref(projectKey: string, runId: string): string {
  return `/projects/${encodeURIComponent(projectKey)}/workflow/runs/${encodeURIComponent(runId)}`
}

/** Open the run composer dialog (prefilled with a story, task, workflow or prompt). */
export function useRunComposer(): RunComposerApi {
  const value = useContext(RunComposerContext)
  if (!value) throw new Error('useRunComposer must be used inside RunComposerProvider')
  return value
}

/** The composer's shortcut as shown to the user (⌘K on a Mac); `Ctrl K` until mounted, so hydration matches. */
export function useComposerShortcut(): string {
  const [label, setLabel] = useState('Ctrl K')
  useEffect(() => {
    if (/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)) setLabel('⌘K')
  }, [])
  return label
}

function ProjectComposer({ projectKey, options, onClose }: { projectKey: string; options: OpenComposerOptions; onClose: () => void }) {
  const current = useCurrentProject()
  const router = useRouter()
  const fetched = useProject(projectKey)
  const project = current.data?.key === projectKey ? current.data : fetched.data
  if (fetched.error && !project) return <UI.ErrorAlert message={fetched.error.message} />
  if (!project) return <UI.Skeleton className="m-3 h-24 rounded-lg" />
  const onOpenRun = options.onOpenRun ?? ((runId: string) => router.push(runHref(project.key, runId)))
  return (
    <RunComposer
      project={project}
      defaults={options}
      variant="dialog"
      autoFocus
      onOpenRun={(id) => {
        onClose()
        onOpenRun(id)
      }}
    />
  )
}

/** Outside a project: which one to run in. */
function ProjectPicker({ onPick }: { onPick: (key: string) => void }) {
  const { data: projects, error } = useProjects()
  if (error) return <UI.ErrorAlert message={error.message} />
  return (
    <UI.Command>
      <UI.CommandInput placeholder="Run in which project?" autoFocus />
      <UI.CommandList>
        <UI.CommandEmpty>{projects ? 'No projects.' : 'Loading…'}</UI.CommandEmpty>
        <UI.CommandGroup heading="Projects">
          {(projects ?? []).map((p) => (
            <UI.CommandItem key={p.key} value={`${p.key} ${p.name}`} onSelect={() => onPick(p.key)}>
              <FolderKanban className="text-muted-foreground" />
              <span className="font-mono text-xs text-muted-foreground">{p.key}</span>
              <span className="truncate">{p.name}</span>
            </UI.CommandItem>
          ))}
        </UI.CommandGroup>
      </UI.CommandList>
    </UI.Command>
  )
}

type DialogState = { mode: 'compose'; options: OpenComposerOptions; picked: string | null } | { mode: 'pick' } | null

export function RunComposerProvider({ children }: { children: ReactNode }) {
  const current = useCurrentProject()
  const router = useRouter()
  const [dialog, setDialog] = useState<DialogState>(null)

  const openComposer = useCallback((options: OpenComposerOptions = {}) => setDialog({ mode: 'compose', options, picked: null }), [])

  /** Quick run: the project's Workflow page with the composer focused, or — outside a project — pick one first. */
  const quickRun = useCallback(() => {
    if (current.key) {
      router.push(quickRunHref(current.key))
      announceQuickRun()
    } else setDialog({ mode: 'pick' })
  }, [current.key, router])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        quickRun()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quickRun])

  const api = useMemo(() => ({ openComposer }), [openComposer])
  const close = () => setDialog(null)
  const composeKey = dialog?.mode === 'compose' ? (dialog.options.projectKey ?? current.key ?? dialog.picked) : null

  return (
    <RunComposerContext.Provider value={api}>
      {children}
      <UI.Dialog open={dialog !== null} onOpenChange={(open) => !open && close()}>
        <UI.DialogContent showCloseButton={false} className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <UI.DialogHeader className="sr-only">
            <UI.DialogTitle>Run in VS Code</UI.DialogTitle>
            <UI.DialogDescription>Describe a quick fix, or pick a story with #, and run it in your VS Code harness.</UI.DialogDescription>
          </UI.DialogHeader>
          {dialog?.mode === 'pick' ? (
            <ProjectPicker
              onPick={(key) => {
                close()
                router.push(quickRunHref(key))
              }}
            />
          ) : dialog?.mode === 'compose' ? (
            composeKey ? (
              <ProjectComposer
                key={`${composeKey}:${dialog.options.storyNumber ?? ''}:${dialog.options.taskNumber ?? ''}:${dialog.options.workflowId ?? ''}`}
                projectKey={composeKey}
                options={dialog.options}
                onClose={close}
              />
            ) : (
              <ProjectPicker onPick={(key) => setDialog({ ...dialog, picked: key })} />
            )
          ) : null}
        </UI.DialogContent>
      </UI.Dialog>
    </RunComposerContext.Provider>
  )
}
