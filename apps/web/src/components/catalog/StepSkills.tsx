'use client'

// The skills an agent step may use, besides its agent. Leads and owners pick from the project's enabled skills;
// everyone else sees them read-only. When the step runs, the skills are given to the harness and the run records
// which ones were actually used. Each change is saved straight away.

import { useState } from 'react'
import type { Agent } from '@sdlc/contracts'
import * as UI from '@/imports/UI.imports'
import { AppError } from '@/appError'
import { setStepSkills } from '@/service/harnessRun.service'
import { SkillsMultiSelect } from './pickers/SkillsMultiSelect'

interface StepSkillsProps {
  projectKey: string
  workflowId: string
  nodeId: string
  stepLabel: string
  value: string[]
  skills: Agent[]
  canEdit: boolean
  onChanged: (skills: string[], version: number) => void
}

export default function StepSkills({ projectKey, workflowId, nodeId, stepLabel, value, skills, canEdit, onChanged }: StepSkillsProps) {
  const [busy, setBusy] = useState(false)

  async function save(next: string[]): Promise<void> {
    setBusy(true)
    try {
      const res = await setStepSkills(projectKey, workflowId, nodeId, next)
      onChanged(res.skills.map((s) => s.slug), res.version)
    } catch (err) {
      UI.toast.error(err instanceof AppError ? err.message : 'Could not change the step’s skills.')
    } finally {
      setBusy(false)
    }
  }

  return <SkillsMultiSelect catalog={skills} value={value} onChange={(next) => void save(next)} canEdit={canEdit} busy={busy} label={stepLabel} />
}
