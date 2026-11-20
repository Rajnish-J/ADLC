'use client'

// Settings → Appearance: the theme, and how the code editor looks. Both are kept in this browser.

import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import * as UI from '@/imports/UI.imports'
import * as ST from '@/imports/settings.imports'
import SectionHeader from '../SectionHeader'

const THEMES = [
  { id: 'light', label: 'Light', icon: <Sun /> },
  { id: 'dark', label: 'Dark', icon: <Moon /> },
  { id: 'system', label: 'System', icon: <Monitor /> },
]

const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20]

export default function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const [editor, setEditor] = ST.useEditorPreferences()
  const current = theme ?? 'system'

  return (
    <>
      <SectionHeader title="Appearance" description="How the platform looks in this browser." />
      <UI.Card>
        <UI.CardHeader>
          <UI.CardTitle className="text-base">Theme</UI.CardTitle>
          <UI.CardDescription>System follows your operating system’s light or dark mode.</UI.CardDescription>
        </UI.CardHeader>
        <UI.CardContent>
          <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={current === t.id}
                onClick={() => setTheme(t.id)}
                className={UI.cn(
                  'flex items-center gap-3 rounded-lg border p-4 text-left text-sm transition-colors hover:bg-muted/60 [&>svg]:size-5 [&>svg]:text-muted-foreground',
                  current === t.id && 'border-primary bg-primary/5 ring-1 ring-primary',
                )}
              >
                {t.icon}
                <span className="font-medium">{t.label}</span>
              </button>
            ))}
          </div>
        </UI.CardContent>
      </UI.Card>

      <UI.Card>
        <UI.CardHeader>
          <UI.CardTitle className="text-base">Code editor</UI.CardTitle>
          <UI.CardDescription>Used by the Code page’s editor and diffs.</UI.CardDescription>
        </UI.CardHeader>
        <UI.CardContent>
          <UI.FieldGroup>
            <UI.Field orientation="horizontal">
              <UI.FieldContent>
                <UI.FieldLabel htmlFor="editor-font">Font size</UI.FieldLabel>
                <UI.FieldDescription>Size of the code text, in pixels.</UI.FieldDescription>
              </UI.FieldContent>
              <UI.Select value={String(editor.fontSize)} onValueChange={(v) => setEditor({ fontSize: Number(v) })}>
                <UI.SelectTrigger id="editor-font" className="w-28">
                  <UI.SelectValue />
                </UI.SelectTrigger>
                <UI.SelectContent>
                  {FONT_SIZES.map((n) => (
                    <UI.SelectItem key={n} value={String(n)}>
                      {n} px
                    </UI.SelectItem>
                  ))}
                </UI.SelectContent>
              </UI.Select>
            </UI.Field>
            <UI.FieldSeparator />
            <UI.Field orientation="horizontal">
              <UI.FieldContent>
                <UI.FieldLabel htmlFor="editor-wrap">Word wrap</UI.FieldLabel>
                <UI.FieldDescription>Wrap long lines instead of scrolling sideways.</UI.FieldDescription>
              </UI.FieldContent>
              <UI.Switch id="editor-wrap" checked={editor.wordWrap} onCheckedChange={(on) => setEditor({ wordWrap: on })} />
            </UI.Field>
            <UI.FieldSeparator />
            <UI.Field orientation="horizontal">
              <UI.FieldContent>
                <UI.FieldLabel htmlFor="editor-minimap">Minimap</UI.FieldLabel>
                <UI.FieldDescription>The overview of the whole file on the right of the editor.</UI.FieldDescription>
              </UI.FieldContent>
              <UI.Switch id="editor-minimap" checked={editor.minimap} onCheckedChange={(on) => setEditor({ minimap: on })} />
            </UI.Field>
          </UI.FieldGroup>
        </UI.CardContent>
      </UI.Card>
    </>
  )
}
