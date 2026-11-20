'use client'

// The Workflow page's Runs tab: start a run in your VS Code right here (a quick fix, or a story with #), see how runs
// are going across the project, and every run by everyone — each opens its own page.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProjectDetail } from '@sdlc/contracts'
import WorkflowRuns from '@/components/catalog/WorkflowRuns'
import RunComposer, { type RunComposerDefaults } from '@/components/work/RunComposer'
import { runHref } from '@/components/work/RunComposerProvider'
import RunsDashboard from './RunsDashboard'

interface RunsTabProps {
  project: ProjectDetail
  /** Prefill for the composer (from the URL: Quick run, Run again). */
  defaults: RunComposerDefaults
  /** Bumped to bring the composer back into focus (Quick run, Start in VS Code); 0 = don't focus. */
  focus: number
  /** Start with the table narrowed to runs that changed this file (e.g. from the Code page). */
  initialFile?: string
}

export default function RunsTab({ project, defaults, focus, initialFile }: RunsTabProps) {
  const router = useRouter()
  const [user, setUser] = useState<string | undefined>(undefined)
  const [file, setFile] = useState(initialFile ?? '')
  useEffect(() => {
    if (initialFile) setFile(initialFile)
  }, [initialFile])
  const composerRef = useRef<HTMLDivElement>(null)
  const onFile = useCallback((path: string) => setFile(path), [])

  useEffect(() => {
    if (focus > 0) composerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focus])

  return (
    <div className="flex flex-col gap-5">
      <div ref={composerRef}>
        {/* Remounted on each focus request so the box takes focus and the prefill applies afresh. */}
        <RunComposer
          key={`composer-${focus}`}
          project={project}
          defaults={defaults}
          variant="inline"
          autoFocus={focus > 0}
          onOpenRun={(id) => router.push(runHref(project.key, id))}
        />
      </div>
      <RunsDashboard projectKey={project.key} user={user} onFile={onFile} />
      <WorkflowRuns project={project} user={user} onUserChange={setUser} file={file} onFileChange={onFile} />
    </div>
  )
}
