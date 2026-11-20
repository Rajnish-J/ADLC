'use client'

// Monaco, loaded from this app (/monaco/vs — see scripts/copy-monaco.mjs), never from a CDN. The language comes
// from the file name (Monaco infers it from the model path); the theme follows the app's light/dark mode.
// Only imported through ./Monaco (next/dynamic, ssr: false) — Monaco needs a browser.

import { useEffect, useRef } from 'react'
import Editor, { DiffEditor, loader, type DiffOnMount, type OnMount } from '@monaco-editor/react'
import { useTheme } from 'next-themes'
import { Spinner } from '@/components/ui/spinner'
import { useEditorPreferences } from '@/hooks/code/useEditorPreferences'

// Absolute URL: Monaco's web workers (TypeScript, JSON, CSS, HTML language services) resolve their scripts against
// it, and a relative path fails inside a worker. This module only ever runs in the browser (see ./Monaco).
loader.config({ paths: { vs: `${window.location.origin}/monaco/vs` } })

const BASE_OPTIONS = {
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: 'selection' as const,
  smoothScrolling: true,
  tabSize: 2,
}

/** Base options plus the user's editor preferences (Settings → Appearance). */
function useEditorOptions() {
  const [prefs] = useEditorPreferences()
  return { ...BASE_OPTIONS, fontSize: prefs.fontSize, minimap: { enabled: prefs.minimap }, wordWrap: prefs.wordWrap ? ('on' as const) : ('off' as const) }
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner /> Loading editor…
    </div>
  )
}

function useMonacoTheme(): string {
  const { resolvedTheme } = useTheme()
  return resolvedTheme === 'dark' ? 'vs-dark' : 'light'
}

export interface CodeEditorProps {
  /** Unique model path, e.g. `main/src/index.ts` — keeps one undo history per file and picks the language. */
  path: string
  value: string
  readOnly: boolean
  onChange?: (value: string) => void
  /** Ctrl/Cmd+S. */
  onSave?: () => void
  /** Line to reveal when the file opens. */
  line?: number
}

export function CodeEditor({ path, value, readOnly, onChange, onSave, line }: CodeEditorProps) {
  const theme = useMonacoTheme()
  const options = useEditorOptions()
  const saveRef = useRef(onSave)
  useEffect(() => {
    saveRef.current = onSave
  })

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.())
    if (line) {
      editor.revealLineInCenter(line)
      editor.setPosition({ lineNumber: line, column: 1 })
    }
  }

  return (
    <Editor
      path={path}
      value={value}
      theme={theme}
      loading={<Loading />}
      onMount={onMount}
      onChange={(v) => onChange?.(v ?? '')}
      options={{ ...options, readOnly, domReadOnly: readOnly }}
    />
  )
}

export interface CodeDiffProps {
  path: string
  original: string
  modified: string
  /** Wrap long lines (prose such as Markdown documents). */
  wordWrap?: boolean
}

/** Side-by-side (inline on narrow screens) comparison, read-only. */
export function CodeDiff({ path, original, modified, wordWrap }: CodeDiffProps) {
  const theme = useMonacoTheme()
  const options = useEditorOptions()
  const onMount: DiffOnMount = (editor) => {
    // The diff options wrap the modified side only.
    if (wordWrap) editor.getOriginalEditor().updateOptions({ wordWrap: 'on' })
    // Jump to the first change once the diff is computed.
    const sub = editor.onDidUpdateDiff(() => {
      const first = editor.getLineChanges()?.[0]
      if (first) editor.getModifiedEditor().revealLineInCenter(first.modifiedStartLineNumber || 1)
      sub.dispose()
    })
  }
  return (
    <DiffEditor
      original={original}
      modified={modified}
      originalModelPath={`diff-base/${path}`}
      modifiedModelPath={`diff-mine/${path}`}
      // Keep the models on unmount: disposing them first makes the diff widget throw ("TextModel got disposed before
      // DiffEditorWidget model got reset"). They are keyed by path, so they are reused next time.
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      theme={theme}
      loading={<Loading />}
      onMount={onMount}
      options={{
        ...options,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        ...(wordWrap ? { wordWrap: 'on' as const, diffWordWrap: 'on' as const } : {}),
      }}
    />
  )
}
