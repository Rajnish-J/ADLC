// The Python orchestrator enforces the same roles and permissions as this API from a generated copy of the rules
// (services/orchestrator/app/rbac.json). This fails when the copy is stale — run `npm run emit:rbac -w @sdlc/contracts`.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { rbacRules } from '@sdlc/contracts'

test('the orchestrator rbac.json matches @sdlc/contracts', () => {
  const file = join(__dirname, '..', '..', '..', '..', 'services', 'orchestrator', 'app', 'rbac.json')
  const copy = JSON.parse(readFileSync(file, 'utf8')) as unknown
  assert.deepEqual(copy, rbacRules(), 'services/orchestrator/app/rbac.json is stale: run `npm run emit:rbac -w @sdlc/contracts`.')
})
