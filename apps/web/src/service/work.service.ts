import { z } from 'zod'
import {
  PatchSchema,
  ProjectRunDetailSchema,
  ProjectRunSchema,
  StoryWorkSchema,
  type Patch,
  type ProjectRun,
  type ProjectRunDetail,
  type StoryWork,
} from '@sdlc/contracts'
import { apiRequest } from './http'

const storyPath = (key: string, number: number): string => `/projects/${encodeURIComponent(key)}/stories/${number}`

/** Code activity reported from VS Code: who is working now, commits on the story branch, agent runs. */
export function getStoryWork(key: string, number: number): Promise<StoryWork> {
  return apiRequest(`${storyPath(key, number)}/work`, StoryWorkSchema)
}

export function getCommitDiff(key: string, number: number, sha: string): Promise<Patch> {
  return apiRequest(`${storyPath(key, number)}/commits/${encodeURIComponent(sha)}/diff`, PatchSchema)
}

export function getWorkspaceDiff(key: string, number: number, userId: string): Promise<Patch> {
  return apiRequest(`${storyPath(key, number)}/workspace/${encodeURIComponent(userId)}/diff`, PatchSchema)
}

const projectPath = (key: string): string => `/projects/${encodeURIComponent(key)}`

/** Every agent run in the project, newest first (each one's steps load with getRun). */
export function listRuns(key: string): Promise<ProjectRun[]> {
  return apiRequest(`${projectPath(key)}/runs?limit=200`, z.array(ProjectRunSchema))
}

export function getRun(key: string, id: string): Promise<ProjectRunDetail> {
  return apiRequest(`${projectPath(key)}/runs/${encodeURIComponent(id)}`, ProjectRunDetailSchema)
}
