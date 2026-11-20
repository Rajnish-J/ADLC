'use client'

// The full-screen workflow editor (/projects/[key]/workflow/[id]/edit, and /workflow/new for a new one, optionally
// a copy of `?from=<id>`): the step palette, the React Flow canvas and the inspector side by side. Leads and owners
// edit; everyone else gets the same view read-only. Saving sends the whole workflow with the version the edit
// started from, so two people can't silently overwrite each other.

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { ReactFlowProvider } from '@xyflow/react'
import { RefreshCw } from 'lucide-react'
import { KNOWN_HARNESSES, readProjectSettings, type Agent, type AgentDetail } from '@sdlc/contracts'
import { blankSpec } from '@sdlc/core'
import * as UI from '@/imports/UI.imports'
import * as C from '@/imports/catalog.imports'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { getWorkflow } from '@/service/catalog.service'
import AgentFormSheet, { type AgentFormMode } from '../AgentFormSheet'
import EditorCanvas from './EditorCanvas'
import EditorToolbar from './EditorToolbar'
import NodeInspector from './NodeInspector'
import NodePalette from './NodePalette'
import { useWorkflowEditor, type EditorSource } from './useWorkflowEditor'

const toSource = (w: C.WorkflowDetail): EditorSource => ({ id: w.id, name: w.name, description: w.description, version: w.version, isDefault: w.isDefault, spec: w.spec })

interface EditorProps {
  project: C.ProjectDetail
  source: EditorSource
  catalog: Agent[] | null
  onAgentSaved: (agent: AgentDetail) => void
  onSaved: (saved: C.WorkflowDetail) => void
  onDiscard: () => void
  onReload: () => void
}

function Editor({ project, source, catalog, onAgentSaved, onSaved, onDiscard, onReload }: EditorProps) {
  const router = useRouter()
  const readOnly = !project.permissions.includes('workflow.edit')
  const canConfigureAgents = project.permissions.includes('agent.configure')
  const allowed = readProjectSettings(project.settings).allowedEngines
  const harnessOptions = allowed.length ? allowed : KNOWN_HARNESSES.map((h) => h.id)
  const projectPath = `/projects/${encodeURIComponent(project.key)}`

  const editor = useWorkflowEditor({
    projectKey: project.key,
    source,
    catalog,
    allowedHarnesses: allowed,
    onSaved: (saved, created) => (created ? router.replace(`${projectPath}/workflow/${saved.id}/edit`) : onSaved(saved)),
  })
  const [agentSheet, setAgentSheet] = useState<{ mode: AgentFormMode; nodeId?: string } | null>(null)

  // Someone else saved this workflow while it is open here.
  const { data: live } = C.useWorkflow(project.key, source.id)
  const changedElsewhere = !!live && live.version > editor.version && !editor.saving

  const { save } = editor
  useEffect(() => {
    if (readOnly) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [readOnly, save])

  function agentSaved(agent: AgentDetail): void {
    onAgentSaved(agent)
    if (agentSheet?.mode.type === 'create' && agentSheet.nodeId) editor.mapAgent(agentSheet.nodeId, agent)
    if (agentSheet?.mode.type === 'edit') editor.renameAgent(agent.slug, agent.name)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorToolbar editor={editor} backHref={`${projectPath}/workflow${source.id ? `?workflow=${source.id}` : ''}`} readOnly={readOnly} onDiscard={onDiscard} />
      {changedElsewhere ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-4 py-2 text-sm">
          <span className="text-warning-foreground dark:text-warning">
            Someone saved this workflow (now version {live?.version}) since you opened it. Saving will ask before overwriting their changes.
          </span>
          <UI.Button variant="outline" size="xs" className="ml-auto" onClick={onReload}>
            <RefreshCw /> Load their version
          </UI.Button>
        </div>
      ) : null}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        {!readOnly ? (
          <>
            <ResizablePanel defaultSize="19%" minSize="12%" maxSize="32%" className="min-w-0 bg-muted/20">
              <NodePalette catalog={catalog} onAdd={editor.insertStep} />
            </ResizablePanel>
            <ResizableHandle />
          </>
        ) : null}
        <ResizablePanel defaultSize={readOnly ? '72%' : '55%'} minSize="30%" className="min-w-0">
          <EditorCanvas editor={editor} readOnly={readOnly} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={readOnly ? '28%' : '26%'} minSize="18%" maxSize="42%" className="min-w-0 bg-background">
          <NodeInspector
            editor={editor}
            projectKey={project.key}
            catalog={catalog}
            harnessOptions={harnessOptions}
            readOnly={readOnly}
            canConfigureAgents={canConfigureAgents}
            onNewAgent={(nodeId) => setAgentSheet({ mode: { type: 'create' }, nodeId })}
            onEditAgent={(slug) => setAgentSheet({ mode: { type: 'edit', slug } })}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      <AgentFormSheet projectKey={project.key} mode={agentSheet?.mode ?? null} onClose={() => setAgentSheet(null)} onSaved={agentSaved} />

      <UI.AlertDialog open={editor.conflict} onOpenChange={(open) => !open && editor.dismissConflict()}>
        <UI.AlertDialogContent>
          <UI.AlertDialogHeader>
            <UI.AlertDialogTitle>This workflow changed since you opened it</UI.AlertDialogTitle>
            <UI.AlertDialogDescription>
              Someone else saved it while you were editing. Load their version (your changes here are dropped), or overwrite theirs with yours.
            </UI.AlertDialogDescription>
          </UI.AlertDialogHeader>
          <UI.AlertDialogFooter>
            <UI.AlertDialogCancel>Keep editing</UI.AlertDialogCancel>
            <UI.Button variant="outline" onClick={onReload}>
              Load their version
            </UI.Button>
            <UI.AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void editor.save({ overwrite: true })}>
              Overwrite with mine
            </UI.AlertDialogAction>
          </UI.AlertDialogFooter>
        </UI.AlertDialogContent>
      </UI.AlertDialog>
    </div>
  )
}

/** Loads what the editor starts from (the saved workflow, a copy of one, or a blank one) and remounts it on reload/discard. */
function EditorPage({ project }: { project: C.ProjectDetail }) {
  const params = useParams<{ id?: string }>()
  const workflowId = params.id ? decodeURIComponent(params.id) : null
  const copyFrom = useSearchParams().get('from')
  const [source, setSource] = useState<EditorSource | null>(null)
  const [error, setError] = useState<C.AppError | null>(null)
  const [generation, setGeneration] = useState(0)
  const { data: catalog, setData: setCatalog } = C.useAgents(project.key)

  const load = useCallback(async () => {
    setError(null)
    try {
      if (workflowId) {
        setSource(toSource(await getWorkflow(project.key, workflowId)))
      } else if (copyFrom) {
        const original = await getWorkflow(project.key, copyFrom)
        const name = `${original.name} (copy)`.slice(0, 100)
        setSource({ id: null, name, description: original.description, version: 0, isDefault: false, spec: { ...original.spec, name } })
      } else {
        setSource({ id: null, name: 'New workflow', description: '', version: 0, isDefault: false, spec: blankSpec('New workflow') })
      }
      setGeneration((g) => g + 1)
    } catch (err) {
      setError(err instanceof C.AppError ? err : new C.AppError('Could not load the workflow.'))
    }
  }, [project.key, workflowId, copyFrom])

  useEffect(() => {
    void load()
  }, [load])

  if (!workflowId && !project.permissions.includes('workflow.edit')) {
    return (
      <div className="p-6">
        <UI.ErrorAlert title="You can’t create workflows" message="Leads and owners create and edit this project’s workflows." />
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-6">
        <UI.ErrorAlert title={error.status === 404 ? 'Workflow not found' : 'Could not load the workflow'} message={error.message} />
      </div>
    )
  }
  if (!source) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <UI.Skeleton className="h-10" />
        <UI.Skeleton className="min-h-0 flex-1" />
      </div>
    )
  }

  return (
    <ReactFlowProvider key={generation}>
      <Editor
        project={project}
        source={source}
        catalog={catalog}
        onAgentSaved={(agent) => setCatalog([...(catalog ?? []).filter((a) => a.slug !== agent.slug), agent])}
        onSaved={(saved) => setSource(toSource(saved))}
        onDiscard={() => setGeneration((g) => g + 1)}
        onReload={() => void load()}
      />
    </ReactFlowProvider>
  )
}

export default function WorkflowEditorContainer() {
  return <C.ProjectShell header={false}>{(project) => <EditorPage project={project} />}</C.ProjectShell>
}
