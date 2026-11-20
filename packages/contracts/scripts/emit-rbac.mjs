// Writes the role → permission rules as JSON for the Python orchestrator (services/orchestrator/app/rbac.json).
// Run after changing src/rbac.ts: `npm run emit:rbac -w @sdlc/contracts`. apps/api's rbac drift test fails until you do.
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rbacRules } from '../dist/index.js'

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../services/orchestrator/app/rbac.json')
writeFileSync(out, JSON.stringify(rbacRules(), null, 2) + '\n')
console.log(`Wrote ${out}`)
