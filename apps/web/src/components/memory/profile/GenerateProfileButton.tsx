'use client'

// The Memory page's header button: "Generate from repository" (or "Regenerate profile" once there is one).
// Disabled, with the reason, when no repository is linked or a generation is already running.

import { Sparkles } from 'lucide-react'
import { useProjectProfile } from '@/hooks/memory/useProjectProfile'
import * as UI from '@/imports/UI.imports'
import GenerateProfileDialog from './GenerateProfileDialog'

export default function GenerateProfileButton({ projectKey }: { projectKey: string }) {
  const profile = useProjectProfile(projectKey)
  const state = profile.data
  if (!state?.canGenerate) return null
  const generating = state.pending?.status === 'generating'
  const label = state.current ? 'Regenerate profile' : 'Generate from repository'
  if (!state.hasRepository || generating) {
    return (
      <UI.Tooltip>
        <UI.TooltipTrigger asChild>
          <span tabIndex={0}>
            <UI.Button variant="outline" disabled>
              {generating ? <UI.Spinner /> : <Sparkles />} {generating ? 'Generating profile…' : label}
            </UI.Button>
          </span>
        </UI.TooltipTrigger>
        <UI.TooltipContent>{generating ? 'The Project profiler is reading the repository.' : 'Link a repository in Settings → Repository first.'}</UI.TooltipContent>
      </UI.Tooltip>
    )
  }
  return (
    <GenerateProfileDialog
      projectKey={projectKey}
      aiEnabled={state.aiEnabled}
      aiReason={state.aiReason}
      regenerate={Boolean(state.current)}
      trigger={
        <UI.Button variant="outline">
          <Sparkles /> {label}
        </UI.Button>
      }
    />
  )
}
