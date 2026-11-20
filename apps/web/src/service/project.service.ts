import { z } from 'zod'
import {
  ProjectDetailSchema,
  ProjectSummarySchema,
  type AddMemberInput,
  type CreateProjectInput,
  type ProjectDetail,
  type ProjectRole,
  type ProjectSummary,
} from '@sdlc/contracts'
import { apiRequest } from './http'

const projectPath = (key: string): string => `/projects/${encodeURIComponent(key)}`

export function listProjects(): Promise<ProjectSummary[]> {
  return apiRequest('/projects', z.array(ProjectSummarySchema))
}

export function getProject(key: string): Promise<ProjectDetail> {
  return apiRequest(projectPath(key), ProjectDetailSchema)
}

export function createProject(input: CreateProjectInput): Promise<ProjectDetail> {
  return apiRequest('/projects', ProjectDetailSchema, { method: 'POST', body: input })
}

export function addMember(key: string, input: AddMemberInput): Promise<ProjectDetail> {
  return apiRequest(`${projectPath(key)}/members`, ProjectDetailSchema, { method: 'POST', body: input })
}

export function changeMemberRole(key: string, userId: string, role: ProjectRole): Promise<ProjectDetail> {
  return apiRequest(`${projectPath(key)}/members/${userId}`, ProjectDetailSchema, { method: 'PATCH', body: { role } })
}

export function removeMember(key: string, userId: string): Promise<ProjectDetail> {
  return apiRequest(`${projectPath(key)}/members/${userId}`, ProjectDetailSchema, { method: 'DELETE' })
}
