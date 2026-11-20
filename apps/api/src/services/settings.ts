// Engine settings: each user's preferred agent engine, each project's engine limits, and the VS Code clients
// a user has connected (with the engines installed in them). Preferences and presence are user-scoped, so their
// events go only to that user's connections.

import { and, eq } from 'drizzle-orm'
import {
  PRESENCE_ONLINE_MS,
  isHarnessAllowed,
  mergeProjectSettings,
  readProjectSettings,
  type AgentEngine,
  type ClientPresence,
  type ClientPresenceInput,
  type MySettings,
  type ProjectDetail,
  type UpdatePreferencesInput,
  type UpdateProjectInput,
  type UserPreferences,
} from '@sdlc/contracts'
import { actorOf, assertCan, loadProjectAccess } from '../access'
import { writeAudit } from '../audit'
import type { Db } from '../db/client'
import { clientPresence, projects, userPreferences } from '../db/schema'
import { badRequest } from '../http'
import type { Caller, ServiceDeps } from './context'
import { projectDetail } from './projects'

export async function preferencesOf(db: Db, userId: string): Promise<UserPreferences> {
  const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId))
  return {
    agentEngine: (row?.agentEngine as AgentEngine | null | undefined) ?? null,
    engineModel: row?.engineModel ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  }
}

export async function clientsOf(db: Db, userId: string, now = Date.now()): Promise<ClientPresence[]> {
  const rows = await db.select().from(clientPresence).where(eq(clientPresence.userId, userId))
  return rows
    .map((r) => ({
      clientId: r.clientId,
      kind: 'vscode' as const,
      version: r.version,
      engines: r.engines,
      workspace: r.workspace ?? null,
      lastSeenAt: r.lastSeenAt.toISOString(),
      online: now - r.lastSeenAt.getTime() < PRESENCE_ONLINE_MS,
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
}

export async function mySettings(db: Db, userId: string): Promise<MySettings> {
  return { preferences: await preferencesOf(db, userId), clients: await clientsOf(db, userId) }
}

export async function updatePreferences(deps: ServiceDeps, caller: Caller, input: UpdatePreferencesInput): Promise<MySettings> {
  const userId = caller.user.id
  const current = await preferencesOf(deps.db, userId)
  const next = {
    agentEngine: input.agentEngine !== undefined ? input.agentEngine : current.agentEngine,
    engineModel: input.engineModel !== undefined ? input.engineModel || null : current.engineModel,
  }
  await deps.db
    .insert(userPreferences)
    .values({ userId, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { ...next, updatedAt: new Date() } })
  deps.bus.publish({ type: 'preferences.changed', targetUserId: userId })
  return mySettings(deps.db, userId)
}

export async function reportPresence(
  deps: ServiceDeps,
  caller: Caller,
  clientId: string,
  input: ClientPresenceInput,
): Promise<MySettings> {
  const userId = caller.user.id
  // Only installed harnesses are kept: the UIs never offer one the user does not have.
  const engines = input.engines.filter((e) => e.installed !== false).map((e) => ({ ...e, installed: true }))
  const values = { kind: input.kind, version: input.version, engines, workspace: input.workspace, lastSeenAt: new Date() }
  const [before] = await deps.db
    .select()
    .from(clientPresence)
    .where(and(eq(clientPresence.userId, userId), eq(clientPresence.clientId, clientId)))
  await deps.db
    .insert(clientPresence)
    .values({ userId, clientId, ...values })
    .onConflictDoUpdate({ target: [clientPresence.userId, clientPresence.clientId], set: values })
  // Heartbeats are frequent; only tell the web when something it shows actually changed.
  const changed =
    !before ||
    Date.now() - before.lastSeenAt.getTime() >= PRESENCE_ONLINE_MS ||
    JSON.stringify(before.engines) !== JSON.stringify(engines) ||
    JSON.stringify(before.workspace ?? null) !== JSON.stringify(input.workspace)
  if (changed) deps.bus.publish({ type: 'client.changed', targetUserId: userId })
  return mySettings(deps.db, userId)
}

export async function removePresence(deps: ServiceDeps, caller: Caller, clientId: string): Promise<void> {
  await deps.db
    .delete(clientPresence)
    .where(and(eq(clientPresence.userId, caller.user.id), eq(clientPresence.clientId, clientId)))
  deps.bus.publish({ type: 'client.changed', targetUserId: caller.user.id })
}

export async function updateProject(deps: ServiceDeps, caller: Caller, key: string, input: UpdateProjectInput): Promise<ProjectDetail> {
  await deps.db.transaction(async (tx) => {
    const access = await loadProjectAccess(tx, caller.user, key)
    assertCan(access, 'project.update')
    const set: Partial<typeof projects.$inferInsert> = {}
    if (input.name !== undefined) set.name = input.name
    if (input.description !== undefined) set.description = input.description
    if (input.settings) {
      // Each card saves only its own part (harnesses, memory); merge it onto what is stored.
      const current = readProjectSettings(access.project.settings)
      const allowed = input.settings.allowedEngines ?? current.allowedEngines
      const defaultEngine = input.settings.defaultEngine ?? current.defaultEngine
      if (input.settings.defaultEngine !== undefined || input.settings.allowedEngines !== undefined) {
        if (!isHarnessAllowed(defaultEngine, allowed)) throw badRequest('The default engine must be one of the allowed engines')
      }
      set.settings = mergeProjectSettings(current, input.settings)
    }
    if (Object.keys(set).length === 0) return
    await tx.update(projects).set(set).where(eq(projects.id, access.project.id))
    await writeAudit(tx, {
      orgId: access.project.orgId,
      projectId: access.project.id,
      actorUserId: actorOf(caller.user).userId,
      action: input.settings ? 'project.settings_updated' : 'project.updated',
      resourceType: 'project',
      resourceId: access.project.id,
      data: { ...input },
      via: caller.via,
    })
  })
  deps.bus.publish({ type: 'project.changed', projectKey: key, action: 'settings', actorId: caller.user.id })
  return projectDetail(deps.db, caller.user, key)
}
