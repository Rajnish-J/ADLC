// Run records — the Runs tab, a run's page and its parts — imported by containers as `* as R`.

export type { ProjectRun, ProjectRunDetail, RunStats } from '@sdlc/contracts'
export { useRunDetail, useRunDiff, useRunList, useRunStats } from '@/hooks/runs/useRunRecords'
export { generateRunInsight, getRunDetail, getRunDiff, getRunStats, listProjectRuns, setMemoryHelpful, setRunFeedback } from '@/service/runs.service'
export { downloadText, runReportMarkdown, runsCsv, runTitle } from '@/lib/runReport'
export { default as RunsTab } from '@/components/runs/RunsTab'
export { default as RunsDashboard } from '@/components/runs/RunsDashboard'
export { default as RunDetailContainer } from '@/components/runs/RunDetailContainer'
export { default as ImpactPanel } from '@/components/runs/ImpactPanel'
