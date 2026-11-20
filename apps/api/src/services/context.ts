import type { AuthUser } from '../auth'
import type { Db } from '../db/client'
import type { EventBus } from '../events'
import type { RepoManager } from '../repo/jobs'
import type { ContextCurator } from './contextCurator'
import type { MemoryIndexer } from './memoryIndex'
import type { ProfileService } from './projectProfile'

/** What every service needs: the database and the live-event bus (and, in the server, the repository jobs). */
export interface ServiceDeps {
  db: Db
  bus: EventBus
  /** Repository clone/sync jobs. Absent in scripts (seed) — linking a repository then fails with 503. */
  repos?: RepoManager
  /** The project profile (generation jobs, run-triggered proposals). Absent in scripts and most tests. */
  profiles?: ProfileService
  /** Semantic memory search (embeddings). Absent → keyword search only. */
  memoryIndex?: MemoryIndexer
  /** Writes AI-curated run context when a project turns it on. Absent → assembled context only. */
  curator?: ContextCurator
}

/** Who is calling, and through which client (recorded in the audit log). */
export interface Caller {
  user: AuthUser
  via: string
}
