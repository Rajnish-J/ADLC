// Applies the SQL migrations in apps/api/drizzle to the configured database (idempotent).

import * as path from 'path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { loadConfig } from '../config'
import { createDb } from './client'

async function main(): Promise<void> {
  const config = loadConfig()
  const { db, pool } = createDb(config.DATABASE_URL)
  try {
    await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../drizzle') })
    console.log('Migrations applied.')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
