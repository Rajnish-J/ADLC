// Board order. All stories of a project share one rank sequence; a column lists its stories by (rank, number).
// A drop between two cards takes the midpoint of their ranks, and when a gap gets too small the project's ranks
// are spread out again. Rank changes are serialised per project with an advisory lock, so two drops at once can't
// pick the same midpoint. Ranks never bump a story's version: reordering someone's card must not make their
// open drawer stale.

import { and, asc, eq, ne, sql } from 'drizzle-orm'
import type { StoryStatus } from '@sdlc/contracts'
import type { Tx } from '../db/client'
import { stories } from '../db/schema'

export const RANK_STEP = 1024
const MIN_GAP = 1e-6
const RANK_LOCK = 4201

/** The cards a story was dropped between, as the caller saw the column (filters may hide cards in between). */
export interface Placement {
  afterId?: string | null
  beforeId?: string | null
}

export function hasPlacement(place: Placement | undefined): place is Placement {
  return Boolean(place?.afterId || place?.beforeId)
}

export async function lockRanks(tx: Tx, projectId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${RANK_LOCK}, hashtext(${projectId}))`)
}

/** A new story goes after every other story of the project — the bottom of whichever column it starts in. */
export async function bottomRank(tx: Tx, projectId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | string | null>`max(${stories.rank})` })
    .from(stories)
    .where(eq(stories.projectId, projectId))
  return (Number(row?.max) || 0) + RANK_STEP
}

async function rebalanceRanks(tx: Tx, projectId: string): Promise<void> {
  await tx.execute(sql`
    update "stories" as s set "rank" = r.rn * ${RANK_STEP}
    from (select "id", row_number() over (order by "rank", "number") as rn from "stories" where "project_id" = ${projectId}) as r
    where s."id" = r."id"`)
}

/**
 * The rank for a story dropped into `status` at `place`: right after `afterId`, or else right before `beforeId`,
 * in the full column. Null when neither anchor is in that column (the board changed since the caller loaded it).
 * Call inside a transaction holding `lockRanks`.
 */
export async function placeRank(tx: Tx, projectId: string, status: StoryStatus, selfId: string, place: Placement): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const column = await tx
      .select({ id: stories.id, rank: stories.rank })
      .from(stories)
      .where(and(eq(stories.projectId, projectId), eq(stories.status, status), ne(stories.id, selfId)))
      .orderBy(asc(stories.rank), asc(stories.number))

    const after = place.afterId ? column.findIndex((s) => s.id === place.afterId) : -1
    const before = place.beforeId ? column.findIndex((s) => s.id === place.beforeId) : -1
    const index = after >= 0 ? after + 1 : before >= 0 ? before : -1
    if (index < 0) return null

    const prev = column[index - 1]?.rank
    const next = column[index]?.rank
    if (prev === undefined) return next === undefined ? RANK_STEP : next - RANK_STEP
    if (next === undefined) return prev + RANK_STEP
    if (next - prev > MIN_GAP) return (prev + next) / 2
    await rebalanceRanks(tx, projectId)
  }
  return null
}
