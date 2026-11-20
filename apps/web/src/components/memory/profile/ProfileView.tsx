'use client'

// A profile's content: stack chips, then each section as a tab (Markdown), with the repository files it was based on
// linking into the Code page, and the recent changes that shaped it.

import Link from 'next/link'
import { FileCode2 } from 'lucide-react'
import { PROFILE_SECTION_KEYS, PROFILE_SECTION_LABELS, type ProfileContent } from '@sdlc/contracts'
import { Markdown } from '@/components/common/markdown'
import * as UI from '@/imports/UI.imports'

export const MATURITY_META: Record<ProfileContent['maturity'], { label: string; variant: 'secondary' | 'success' | 'warning' | 'outline' }> = {
  prototype: { label: 'Prototype', variant: 'warning' },
  active: { label: 'Active development', variant: 'secondary' },
  stable: { label: 'Stable', variant: 'success' },
  maintenance: { label: 'Maintenance', variant: 'outline' },
}

export function StackChips({ content, max = 14 }: { content: ProfileContent; max?: number }) {
  const { languages, frameworks, packageManagers } = content.stack
  if (!languages.length && !frameworks.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {languages.slice(0, 5).map((l) => (
        <UI.Badge key={l.name} variant="secondary" title={`${l.files} files`}>
          {l.name} <span className="text-muted-foreground tabular-nums">{l.percent}%</span>
        </UI.Badge>
      ))}
      {frameworks.slice(0, max).map((f) => (
        <UI.Badge key={f} variant="outline">
          {f}
        </UI.Badge>
      ))}
      {frameworks.length > max ? <span className="text-xs text-muted-foreground">+{frameworks.length - max} more</span> : null}
      {packageManagers.length ? <span className="text-xs text-muted-foreground">· {packageManagers.join(', ')}</span> : null}
    </div>
  )
}

interface ProfileViewProps {
  content: ProfileContent
  projectKey: string
  branch: string | null
  /** On the tabs root — e.g. `min-h-0 flex-1` to fill a fixed-height panel. */
  className?: string
  /** On each section panel — e.g. `min-h-0 overflow-y-auto` so the section scrolls under pinned tabs. */
  panelClassName?: string
}

export default function ProfileView({ content, projectKey, branch, className, panelClassName }: ProfileViewProps) {
  const codeHref = (path: string) => `/projects/${projectKey}/code?${new URLSearchParams({ ...(branch ? { branch } : {}), path }).toString()}`
  return (
    <UI.Tabs defaultValue="overview" className={UI.cn('gap-3', className)}>
      {/* Scrolls sideways in narrow panels rather than wrapping (the list has a fixed height). */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <UI.TabsList>
          {PROFILE_SECTION_KEYS.map((k) => (
            <UI.TabsTrigger key={k} value={k}>
              {PROFILE_SECTION_LABELS[k]}
            </UI.TabsTrigger>
          ))}
          {content.changelog.length ? <UI.TabsTrigger value="changes">Recent changes</UI.TabsTrigger> : null}
        </UI.TabsList>
      </div>
      {PROFILE_SECTION_KEYS.map((k) => {
        const section = content.sections[k]
        return (
          <UI.TabsContent key={k} value={k} className={UI.cn('flex flex-col gap-3', panelClassName)}>
            <Markdown source={section.markdown.trim() || '_Nothing recorded yet._'} className="text-sm" />
            {section.sources.length ? (
              <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
                <span className="text-xs text-muted-foreground">Based on</span>
                {section.sources.map((p) => (
                  <Link key={p} href={codeHref(p)} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground">
                    <FileCode2 className="size-3" />
                    {p}
                  </Link>
                ))}
              </div>
            ) : null}
          </UI.TabsContent>
        )
      })}
      {content.changelog.length ? (
        <UI.TabsContent value="changes" className={panelClassName}>
          <ul className="flex flex-col gap-2 text-sm">
            {content.changelog.map((c, i) => (
              <li key={`${c.runId ?? 'gen'}-${i}`} className="flex items-baseline gap-3">
                <span className="w-20 shrink-0 text-xs text-muted-foreground tabular-nums" title={UI.dateTime(c.at)}>
                  {c.at.slice(0, 10)}
                </span>
                <span className="flex-1">{c.summary}</span>
                {c.runId ? (
                  <Link href={`/projects/${encodeURIComponent(projectKey)}/workflow/runs/${c.runId}`} className="shrink-0 text-xs text-primary hover:underline">
                    View run
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </UI.TabsContent>
      ) : null}
    </UI.Tabs>
  )
}
