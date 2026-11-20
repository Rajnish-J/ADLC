import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export type Db = NodePgDatabase<typeof schema>
/** A transaction handle — same query API as Db. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export function createDb(databaseUrl: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 })
  return { db: drizzle(pool, { schema }), pool }
}
