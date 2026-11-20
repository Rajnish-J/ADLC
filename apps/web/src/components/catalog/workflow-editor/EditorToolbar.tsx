'use client'

// The editor's top bar: back to the Workflow page, the workflow's name, what was saved, the live checks (click
// a problem to jump to its step), auto-layout, discard and save.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleAlert, LayoutGrid, Loader2, RotateCcw, Save } from 'lucide-react'
import * as UI from '@/imports/UI.imports'
import type { WorkflowEditorState } from './useWorkflowEditor'

function Checks({ editor }: { editor: WorkflowEditorState }) {
  const { validation, issues, errorCount, warningCount } = editor
  const label = (nodeId: string): string => editor.nodes.find((n) => n.id === nodeId)?.data.label || nodeId
  const ok = errorCount === 0 && warningCount === 0
  return (
    <UI.Popover>
      <UI.PopoverTrigger asChild>
        <UI.Button variant="ghost" size="sm" aria-label="Checks">
          {errorCount ? (
            <CircleAlert className="text-destructive" />
          ) : warningCount ? (
            <AlertTriangle className="text-warning-foreground dark:text-warning" />
          ) : (
            <CheckCircle2 className="text-success" />
          )}
          <span className="hidden sm:inline">{ok ? 'Ready' : [errorCount && `${errorCount} to fix`, warningCount && `${warningCount} warning${warningCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</span>
        </UI.Button>
      </UI.PopoverTrigger>
      <UI.PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">Checks</div>
        {ok ? (
          <p className="p-3 text-sm text-muted-foreground">Every step is connected and configured. The server checks it again when you save.</p>
        ) : (
          <ul className="flex max-h-80 flex-col overflow-y-auto p-1">
            {validation.errors.map((m) => (
              <li key={`e:${m}`} className="flex gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive">
                <CircleAlert className="mt-px size-3.5 shrink-0" /> {m}
              </li>
            ))}
            {issues.map((i) => (
              <li key={`${i.nodeId}:${i.message}`}>
                <button
                  type="button"
                  onClick={() => editor.selectStep(i.nodeId, true)}
                  className={UI.cn(
                    'flex w-full gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent',
                    i.level === 'error' ? 'text-destructive' : 'text-warning-foreground dark:text-warning',
                  )}
                >
                  {i.level === 'error' ? <CircleAlert className="mt-px size-3.5 shrink-0" /> : <AlertTriangle className="mt-px size-3.5 shrink-0" />}
                  <span>
                    <span className="font-medium">{label(i.nodeId)}:</span> {i.message}
                  </span>
                </button>
              </li>
            ))}
            {validation.warnings.map((m) => (
              <li key={`w:${m}`} className="flex gap-2 rounded-sm px-2 py-1.5 text-xs text-warning-foreground dark:text-warning">
                <AlertTriangle className="mt-px size-3.5 shrink-0" /> {m}
              </li>
            ))}
          </ul>
        )}
      </UI.PopoverContent>
    </UI.Popover>
  )
}

export default function EditorToolbar({
  editor,
  backHref,
  readOnly,
  onDiscard,
}: {
  editor: WorkflowEditorState
  backHref: string
  readOnly: boolean
  onDiscard: () => void
}) {
  const router = useRouter()
  const [confirm, setConfirm] = useState<'leave' | 'discard' | null>(null)
  const unsaved = editor.dirty && !readOnly

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
      <UI.Button variant="ghost" size="icon-sm" aria-label="Back to the Workflow page" onClick={() => (unsaved ? setConfirm('leave') : router.push(backHref))}>
        <ArrowLeft />
      </UI.Button>
      <UI.Input
        value={editor.name}
        onChange={(e) => editor.setName(e.target.value)}
        disabled={readOnly}
        aria-label="Workflow name"
        placeholder="Workflow name"
        className="h-8 w-48 border-transparent bg-transparent px-2 text-base font-semibold shadow-none hover:border-input focus-visible:border-ring sm:w-72 dark:bg-transparent"
      />
      {editor.isNew ? (
        <UI.Badge variant="secondary">New</UI.Badge>
      ) : (
        <UI.Badge variant="outline" className="tabular-nums" title="Saved version">
          v{editor.version}
        </UI.Badge>
      )}
      {unsaved && !editor.isNew ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}

      <div className="ml-auto flex items-center gap-1">
        <Checks editor={editor} />
        {!readOnly ? (
          <>
            <UI.Button variant="ghost" size="sm" onClick={editor.autoLayout} title="Arrange the steps left to right">
              <LayoutGrid /> <span className="hidden md:inline">Auto-layout</span>
            </UI.Button>
            {!editor.isNew ? (
              <UI.Button variant="ghost" size="sm" disabled={!editor.dirty || editor.saving} onClick={() => setConfirm('discard')}>
                <RotateCcw /> <span className="hidden md:inline">Discard</span>
              </UI.Button>
            ) : null}
            <UI.Button
              size="sm"
              disabled={editor.saving || editor.errorCount > 0 || (!editor.dirty && !editor.isNew)}
              onClick={() => void editor.save()}
              title={editor.errorCount ? 'Fix the problems under Checks first' : 'Save (Ctrl/⌘ S)'}
            >
              {editor.saving ? <Loader2 className="animate-spin" /> : <Save />} {editor.isNew ? 'Create workflow' : 'Save'}
            </UI.Button>
          </>
        ) : null}
      </div>

      <UI.AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <UI.AlertDialogContent>
          <UI.AlertDialogHeader>
            <UI.AlertDialogTitle>{confirm === 'leave' ? 'Leave without saving?' : 'Discard your changes?'}</UI.AlertDialogTitle>
            <UI.AlertDialogDescription>
              {confirm === 'leave'
                ? 'Your changes to this workflow haven’t been saved and will be lost.'
                : `The workflow goes back to version ${editor.version} as it was saved.`}
            </UI.AlertDialogDescription>
          </UI.AlertDialogHeader>
          <UI.AlertDialogFooter>
            <UI.AlertDialogCancel>Keep editing</UI.AlertDialogCancel>
            <UI.AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => (confirm === 'leave' ? router.push(backHref) : onDiscard())}
            >
              {confirm === 'leave' ? 'Leave' : 'Discard'}
            </UI.AlertDialogAction>
          </UI.AlertDialogFooter>
        </UI.AlertDialogContent>
      </UI.AlertDialog>
    </div>
  )
}
