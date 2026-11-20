'use client'

// The project profile's state when it needs attention — being generated, failed, or an update from runs waiting
// for review. Nothing otherwise: the profile itself is a row in the memory table ("Project profile vN").

import { Inbox, TriangleAlert } from 'lucide-react'
import type { ProjectProfileState } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'

export default function ProfileStatusBanner({ state, onReview }: { state: ProjectProfileState; onReview: () => void }) {
  const { current, pending } = state
  if (pending?.status === 'generating') {
    return (
      <UI.Alert>
        <UI.Spinner />
        <UI.AlertTitle>The Project profiler is reading {pending.branch ?? 'the repository'}…</UI.AlertTitle>
        <UI.AlertDescription>The profile is added to project memory as v{pending.version} when it is written (usually within a minute or two).</UI.AlertDescription>
      </UI.Alert>
    )
  }
  if (pending?.status === 'failed') {
    return (
      <UI.Alert variant="destructive">
        <TriangleAlert />
        <UI.AlertTitle>Generating the project profile failed</UI.AlertTitle>
        <UI.AlertDescription>{pending.error ?? 'Unknown error.'} Use “{current ? 'Regenerate profile' : 'Generate from repository'}” to try again.</UI.AlertDescription>
      </UI.Alert>
    )
  }
  if (pending?.status === 'proposed') {
    return (
      <UI.Alert>
        <Inbox />
        <UI.AlertTitle>
          A project profile update from {pending.runIds.length} run{pending.runIds.length === 1 ? '' : 's'} is waiting for review
        </UI.AlertTitle>
        <UI.AlertDescription className="flex flex-wrap items-center gap-2">
          Agents keep getting v{current?.version} until a lead accepts it.
          <UI.Button size="sm" variant="link" className="h-auto p-0" onClick={onReview}>
            Review it
          </UI.Button>
        </UI.AlertDescription>
      </UI.Alert>
    )
  }
  return null
}
