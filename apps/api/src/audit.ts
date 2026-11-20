// Audit writes. Always called inside the transaction that makes the change, so a change and its audit row
// commit together or not at all. The table itself rejects UPDATE/DELETE (see the custom migration).

import type { Tx } from './db/client'
import { auditLog } from './db/schema'

export interface AuditInput {
  orgId: string
  projectId?: string | null
  actorUserId: string | null
  action: string
  resourceType: string
  resourceId: string
  data?: Record<string, unknown>
  via: string
}

export async function writeAudit(tx: Tx, entry: AuditInput): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: entry.orgId,
    projectId: entry.projectId ?? null,
    actorUserId: entry.actorUserId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    data: entry.data ?? {},
    via: entry.via,
  })
}
