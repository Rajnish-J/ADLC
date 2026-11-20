import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changeSize, classifyRunImpact, impactArea, impactCategory, type ImpactFile } from './runImpact'

const file = (path: string, additions = 10, deletions = 0, status = 'modified', extra: Partial<ImpactFile> = {}): ImpactFile => ({
  path,
  status,
  additions,
  deletions,
  ...extra,
})

test('categories: first match wins', () => {
  assert.equal(impactCategory('apps/web/src/components/Button.test.tsx'), 'tests')
  assert.equal(impactCategory('services/orchestrator/tests/test_runner.py'), 'tests')
  assert.equal(impactCategory('.github/workflows/ci.yml'), 'ci')
  assert.equal(impactCategory('apps/api/package.json'), 'dependencies')
  assert.equal(impactCategory('package-lock.json'), 'dependencies')
  assert.equal(impactCategory('apps/api/drizzle/0016_run_records.sql'), 'database')
  assert.equal(impactCategory('docs/guide.md'), 'docs')
  assert.equal(impactCategory('README.md'), 'docs')
  assert.equal(impactCategory('apps/web/tsconfig.json'), 'config')
  assert.equal(impactCategory('.eslintrc'), 'config')
  assert.equal(impactCategory('apps/api/src/routes/runs.ts'), 'api')
  assert.equal(impactCategory('apps/api/src/workRoutes.ts'), 'api')
  assert.equal(impactCategory('apps/web/src/components/runs/RunHeader.tsx'), 'ui')
  assert.equal(impactCategory('apps/web/public/logo.svg'), 'assets')
  assert.equal(impactCategory('packages/core/src/runs/runImpact.ts'), 'source')
})

test('areas: two folders deep, then one, then root', () => {
  assert.equal(impactArea('apps/web/src/x.ts'), 'apps/web')
  assert.equal(impactArea('src/x.ts'), 'src')
  assert.equal(impactArea('README.md'), '(root)')
  assert.equal(impactArea('apps\\api\\src\\x.ts'), 'apps/api')
})

test('change size buckets', () => {
  assert.equal(changeSize(0), 'none')
  assert.equal(changeSize(5), 'xs')
  assert.equal(changeSize(49), 's')
  assert.equal(changeSize(200), 'm')
  assert.equal(changeSize(999), 'l')
  assert.equal(changeSize(1000), 'xl')
})

test('totals, statuses and areas sorted by lines', () => {
  const impact = classifyRunImpact([
    file('apps/web/src/a.tsx', 100, 20),
    file('apps/web/src/b.tsx', 5, 0, 'added'),
    file('apps/api/src/c.ts', 10, 10, 'deleted'),
    file('apps/api/src/d.ts', 1, 1, 'renamed', { oldPath: 'apps/api/src/e.ts' }),
  ])
  assert.equal(impact.files, 4)
  assert.equal(impact.additions, 116)
  assert.equal(impact.deletions, 31)
  assert.equal(impact.size, 'm')
  assert.deepEqual(impact.byStatus, { added: 1, modified: 1, deleted: 1, renamed: 1, other: 0 })
  assert.deepEqual(
    impact.areas.map((a) => a.area),
    ['apps/web', 'apps/api'],
  )
  assert.equal(impact.categories[0].category, 'ui')
})

test('risk flags', () => {
  const impact = classifyRunImpact([
    file('apps/api/drizzle/0016_run_records.sql', 40),
    file('.env', 2),
    file('.env.example', 2),
    file('apps/api/src/auth/session.ts', 12),
    file('.github/workflows/ci.yml', 3),
    file('apps/web/package.json', 1, 1),
    file('apps/web/src/old.ts', 0, 200, 'deleted'),
  ])
  const ids = impact.risks.map((r) => r.id)
  assert.ok(ids.includes('secrets'))
  assert.deepEqual(impact.risks.find((r) => r.id === 'secrets')?.files, ['.env'])
  assert.ok(ids.includes('migration'))
  assert.ok(ids.includes('security'))
  assert.ok(ids.includes('ci'))
  assert.ok(ids.includes('dependencies'))
  assert.ok(ids.includes('deleted_files'))
  assert.ok(ids.includes('large_deletion'))
  assert.ok(ids.includes('untested'))
  // Most severe first.
  assert.equal(impact.risks[0].severity, 'high')
  assert.equal(impact.risks.at(-1)?.severity, 'low')
})

test('no untested flag when tests changed too; no flags for nothing', () => {
  const impact = classifyRunImpact([file('src/a.ts', 10), file('src/a.test.ts', 10)])
  assert.ok(!impact.risks.some((r) => r.id === 'untested'))
  assert.deepEqual(classifyRunImpact([]).risks, [])
  assert.equal(classifyRunImpact([]).size, 'none')
})

test('large change flags the biggest files', () => {
  const files = Array.from({ length: 60 }, (_, i) => file(`src/f${i}.ts`, i, 0))
  const risk = classifyRunImpact(files).risks.find((r) => r.id === 'large_change')
  assert.ok(risk)
  assert.equal(risk.files[0], 'src/f59.ts')
})
