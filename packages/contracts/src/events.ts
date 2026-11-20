// Live events pushed over Server-Sent Events (GET /api/v1/events). They carry ids only — clients refetch what
// changed — so a client that missed events never shows stale data: on reconnect it simply reloads.

import { z } from 'zod'
import { PROFILE_STATUSES } from './projectProfile'
import { REPO_STATUSES } from './repo'

export const PlatformEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({
    type: z.literal('project.changed'),
    projectKey: z.string(),
    action: z.string(),
    actorId: z.string().nullable(),
  }),
  z.object({
    type: z.literal('story.changed'),
    projectKey: z.string(),
    storyNumber: z.number().int(),
    action: z.string(),
    actorId: z.string().nullable(),
  }),
  z.object({
    type: z.literal('memory.changed'),
    projectKey: z.string(),
    /** The story whose memory changed; null for project memory. */
    storyNumber: z.number().int().nullable(),
    action: z.string(),
    actorId: z.string().nullable(),
  }),
  /** The project profile changed: generated, proposed after runs, accepted, rejected or edited. */
  z.object({
    type: z.literal('profile.changed'),
    projectKey: z.string(),
    profileId: z.string(),
    status: z.enum(PROFILE_STATUSES),
    actorId: z.string().nullable(),
  }),
  z.object({
    type: z.literal('work.changed'),
    projectKey: z.string(),
    /** null for a quick fix (no story). */
    storyNumber: z.number().int().nullable(),
    /** What was reported from VS Code: the live working state, new commits, or an agent run. */
    kind: z.enum(['workspace', 'commits', 'run']),
    actorId: z.string().nullable(),
    /** The run that changed, for kind `run`. */
    runId: z.string().optional(),
  }),
  z.object({
    type: z.literal('run.activity'),
    projectKey: z.string(),
    /** null for a quick fix (no story). */
    storyNumber: z.number().int().nullable(),
    runId: z.string(),
    /** The highest event seq now stored; fetch `GET …/runs/:id/events?after=` to catch up. */
    lastSeq: z.number().int(),
  }),
  z.object({
    type: z.literal('repo.changed'),
    projectKey: z.string(),
    /** The repository's status after the change. */
    status: z.enum(REPO_STATUSES),
    /** The branch that changed, when the change was about one branch. */
    branch: z.string().nullable(),
    syncId: z.string().nullable(),
    actorId: z.string().nullable(),
  }),
  // User-targeted events: delivered only to the SSE connections of `targetUserId`.
  z.object({
    type: z.literal('preferences.changed'),
    targetUserId: z.string(),
  }),
  z.object({
    type: z.literal('client.changed'),
    targetUserId: z.string(),
  }),
  /** A run was started from the web: the user's VS Code should claim and start it. */
  z.object({
    type: z.literal('run.requested'),
    targetUserId: z.string(),
    runId: z.string(),
    projectKey: z.string(),
    /** null for a quick fix (no story). */
    storyNumber: z.number().int().nullable(),
    /** The window it should start in; null = any window with the harness. */
    clientId: z.string().nullable(),
    engine: z.string(),
  }),
  /**
   * An orchestrator-driven run has an agent step waiting for a harness. The window that claimed the run opens (or
   * re-opens) that harness if it is not already working on the run.
   */
  z.object({
    type: z.literal('run.step'),
    targetUserId: z.string(),
    runId: z.string(),
    projectKey: z.string(),
    /** null for a quick fix (no story). */
    storyNumber: z.number().int().nullable(),
    stepId: z.string(),
    nodeId: z.string(),
    phase: z.enum(['plan', 'execute']),
    harness: z.string(),
    clientId: z.string().nullable(),
  }),
  /** Someone on the web asked the VS Code window running a run to act on it. */
  z.object({
    type: z.literal('run.command'),
    targetUserId: z.string(),
    runId: z.string(),
    command: z.enum(['cancel']),
    actorId: z.string().nullable(),
  }),
])
export type PlatformEvent = z.infer<typeof PlatformEventSchema>

/** The user an event is addressed to, or null when it is project-scoped. */
export function eventTargetUser(e: PlatformEvent): string | null {
  return 'targetUserId' in e ? e.targetUserId : null
}

/** The SSE `event:` name every platform event is sent under. */
export const PLATFORM_EVENT = 'platform'

/** Header the clients send so the audit log records which client made a change. */
export const CLIENT_HEADER = 'x-sdlc-client'
export type ClientKind = 'web' | 'extension'
