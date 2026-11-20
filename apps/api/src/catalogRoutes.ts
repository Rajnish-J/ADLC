// Catalog routes: a project's agents and skills (list, read, enable, and create/edit/delete the platform-defined
// ones), its workflows (list, read, create, edit, make default, delete, map an agent / pin a harness onto a step) and
// the cross-project portfolio overview. Thin: parse, call the service (agents and workflows are served by the
// orchestrator service), return the contract shape.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  SetStepAgentInputSchema,
  SetStepHarnessInputSchema,
  ToggleAgentInputSchema,
  type Agent,
  type AgentDetail,
  type PortfolioProject,
  type SetStepAgentResult,
  type SetStepHarnessResult,
  type WorkflowDetail,
  type WorkflowSummary,
} from '@sdlc/contracts'
import { parse } from './http'
import { caller, KeyParams } from './routeKit'
import * as agentService from './services/agents'
import type { ServiceDeps } from './services/context'
import { portfolio } from './services/portfolio'
import * as workflowService from './services/workflows'

const AgentParams = KeyParams.extend({ slug: z.string().min(1).max(100) })
const WorkflowParams = KeyParams.extend({ id: z.string().uuid() })
const WorkflowNodeParams = WorkflowParams.extend({ nodeId: z.string().min(1).max(200) })

export function registerCatalogRoutes(app: FastifyInstance, deps: ServiceDeps): void {
  const { db } = deps

  // ─── Agents & skills ───────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:key/agents', async (req): Promise<Agent[]> => {
    const { key } = parse(KeyParams, req.params)
    return agentService.listAgents(db, req.user, key)
  })

  app.post('/api/v1/projects/:key/agents', async (req, reply): Promise<AgentDetail> => {
    const { key } = parse(KeyParams, req.params)
    const created = await agentService.createPlatformAgent(deps, caller(req), key, req.body as never)
    reply.code(201)
    return created
  })

  app.get('/api/v1/projects/:key/agents/:slug', async (req): Promise<AgentDetail> => {
    const { key, slug } = parse(AgentParams, req.params)
    return agentService.getAgent(db, req.user, key, slug)
  })

  /** Enable or disable any agent or skill in the project. */
  app.put('/api/v1/projects/:key/agents/:slug', async (req) => {
    const { key, slug } = parse(AgentParams, req.params)
    const { enabled } = parse(ToggleAgentInputSchema, req.body)
    return agentService.setAgentEnabled(deps, caller(req), key, slug, enabled)
  })

  /** Edit a platform agent or skill's definition. */
  app.patch('/api/v1/projects/:key/agents/:slug', async (req): Promise<AgentDetail> => {
    const { key, slug } = parse(AgentParams, req.params)
    return agentService.updatePlatformAgent(deps, caller(req), key, slug, req.body as never)
  })

  app.delete('/api/v1/projects/:key/agents/:slug', async (req) => {
    const { key, slug } = parse(AgentParams, req.params)
    return agentService.deletePlatformAgent(deps, caller(req), key, slug)
  })

  // ─── Workflows ─────────────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:key/workflows', async (req): Promise<WorkflowSummary[]> => {
    const { key } = parse(KeyParams, req.params)
    return workflowService.listWorkflows(db, req.user, key)
  })

  app.post('/api/v1/projects/:key/workflows', async (req, reply): Promise<WorkflowDetail> => {
    const { key } = parse(KeyParams, req.params)
    const created = await workflowService.createWorkflow(deps, caller(req), key, req.body as never)
    reply.code(201)
    return created
  })

  app.get('/api/v1/projects/:key/workflows/:id', async (req): Promise<WorkflowDetail> => {
    const { key, id } = parse(WorkflowParams, req.params)
    return workflowService.getWorkflow(db, req.user, key, id)
  })

  app.patch('/api/v1/projects/:key/workflows/:id', async (req): Promise<WorkflowDetail> => {
    const { key, id } = parse(WorkflowParams, req.params)
    return workflowService.updateWorkflow(deps, caller(req), key, id, req.body as never)
  })

  app.post('/api/v1/projects/:key/workflows/:id/default', async (req): Promise<WorkflowSummary> => {
    const { key, id } = parse(WorkflowParams, req.params)
    return workflowService.setDefaultWorkflow(deps, caller(req), key, id)
  })

  app.delete('/api/v1/projects/:key/workflows/:id', async (req) => {
    const { key, id } = parse(WorkflowParams, req.params)
    return workflowService.deleteWorkflow(deps, caller(req), key, id)
  })

  // Map an agent onto one agent step of a project workflow (null unbinds it).
  app.put('/api/v1/projects/:key/workflows/:id/nodes/:nodeId/agent', async (req): Promise<SetStepAgentResult> => {
    const { key, id, nodeId } = parse(WorkflowNodeParams, req.params)
    return workflowService.setStepAgent(deps, caller(req), key, id, nodeId, parse(SetStepAgentInputSchema, req.body))
  })

  // Pin an agent step to a harness (null = the harness the run is started with).
  app.put('/api/v1/projects/:key/workflows/:id/nodes/:nodeId/harness', async (req): Promise<SetStepHarnessResult> => {
    const { key, id, nodeId } = parse(WorkflowNodeParams, req.params)
    return workflowService.setStepHarness(deps, caller(req), key, id, nodeId, parse(SetStepHarnessInputSchema, req.body))
  })

  // ─── Portfolio ─────────────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/portfolio', async (req): Promise<PortfolioProject[]> => portfolio(db, req.user))
}
