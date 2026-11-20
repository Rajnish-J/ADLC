import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectProfileEvidence,
  countLanguages,
  envVarNames,
  manifestDependencies,
  profileFilesToRead,
  renderProfileEvidence,
} from './collectEvidence'

const NODE_MONOREPO: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'acme', workspaces: ['apps/*', 'packages/*'], scripts: { dev: 'turbo dev', test: 'turbo test' }, devDependencies: { turbo: '1', eslint: '9' } }),
  'package-lock.json': '{}',
  'README.md': '# Acme\nA platform that ships widgets.',
  'apps/web/package.json': JSON.stringify({ name: '@acme/web', dependencies: { next: '15', react: '19', tailwindcss: '4' }, devDependencies: { vitest: '2' } }),
  'apps/api/package.json': JSON.stringify({ name: '@acme/api', dependencies: { fastify: '5', 'drizzle-orm': '0.3', pg: '8' } }),
  'apps/api/.env.example': 'DATABASE_URL=postgres://user:secret@localhost/db\nexport API_KEY=abc\n# comment\n',
  '.github/workflows/ci.yml': 'on: push\njobs: {}',
  'apps/web/src/app/page.tsx': '',
  'apps/web/src/app/layout.tsx': '',
  'apps/api/src/server.ts': '',
  'apps/api/src/server.test.ts': '',
  'apps/api/dist/server.js': '',
  'apps/api/drizzle.config.ts': '',
}

const PYTHON_APP: Record<string, string> = {
  'pyproject.toml': '[project]\nname = "orders"\ndependencies = [\n  "fastapi>=0.110",\n  "sqlalchemy[asyncio]>=2",\n  "uvicorn",\n]\n[tool.poetry.dev-dependencies]\npytest = "^8"\n',
  'uv.lock': '',
  'app/main.py': '',
  'app/models.py': '',
  'tests/test_main.py': '',
  'Dockerfile': 'FROM python:3.12',
}

function evidenceOf(repo: Record<string, string>) {
  const paths = Object.keys(repo)
  const wanted = profileFilesToRead(paths)
  return collectProfileEvidence(paths, new Map(wanted.map((p) => [p, repo[p]])))
}

test('node monorepo: languages, frameworks, modules, package manager, tests', () => {
  const e = evidenceOf(NODE_MONOREPO)
  assert.deepEqual(e.languages.map((l) => l.name), ['TypeScript'])
  assert.equal(e.languages[0].files, 5, 'dist/ output is not counted')
  for (const f of ['Next.js', 'React', 'Tailwind CSS', 'Fastify', 'Drizzle ORM', 'PostgreSQL', 'Vitest', 'ESLint', 'Turborepo']) {
    assert.ok(e.frameworks.includes(f), `${f} detected`)
  }
  assert.deepEqual(e.packageManagers, ['npm'])
  assert.deepEqual(
    e.modules.map((m) => [m.path, m.name, m.kind]),
    [['.', 'acme', 'workspace root'], ['apps/api', '@acme/api', 'node'], ['apps/web', '@acme/web', 'node']],
  )
  assert.equal(e.tests.files, 1)
  assert.deepEqual(e.tests.frameworks, ['Vitest'])
  assert.equal(e.ci.length, 1)
  assert.ok(e.configs.includes('apps/api/drizzle.config.ts'))
  assert.equal(e.docs[0].path, 'README.md')
})

test('python app: pyproject dependencies, uv, Docker, module name', () => {
  const e = evidenceOf(PYTHON_APP)
  assert.deepEqual(e.languages.map((l) => l.name), ['Python'])
  for (const f of ['FastAPI', 'SQLAlchemy', 'Uvicorn', 'pytest', 'Docker']) assert.ok(e.frameworks.includes(f), `${f} detected`)
  assert.ok(e.packageManagers.includes('uv'))
  assert.deepEqual(e.modules, [{ path: '.', name: 'orders', kind: 'python' }])
  assert.equal(e.tests.files, 1)
})

test('empty repository gives empty evidence and still renders', () => {
  const e = collectProfileEvidence([], new Map())
  assert.equal(e.totalFiles, 0)
  assert.deepEqual(e.languages, [])
  assert.match(renderProfileEvidence(e), /none detected/)
})

test('env example files expose variable names only, never values', () => {
  assert.deepEqual(envVarNames(NODE_MONOREPO['apps/api/.env.example']), ['DATABASE_URL', 'API_KEY'])
  const text = renderProfileEvidence(evidenceOf(NODE_MONOREPO))
  assert.ok(text.includes('DATABASE_URL'))
  assert.ok(!text.includes('secret@localhost'))
})

test('render respects the budget and is deterministic', () => {
  const e = evidenceOf(NODE_MONOREPO)
  assert.equal(renderProfileEvidence(e), renderProfileEvidence(evidenceOf(NODE_MONOREPO)))
  assert.ok(renderProfileEvidence(e, 300).length < 360)
})

test('manifest parsers', () => {
  assert.deepEqual(manifestDependencies('requirements.txt', 'Django==5.0\n# c\nrequests>=2 ; python_version>"3"\n'), ['django', 'requests'])
  assert.deepEqual(manifestDependencies('go.mod', 'module x\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n)\n'), ['github.com/gin-gonic/gin'])
  assert.deepEqual(manifestDependencies('Api.csproj', '<PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8" />'), ['microsoft.aspnetcore.openapi'])
  assert.deepEqual(countLanguages(['a.ts', 'b.py', 'c.py', 'README.md']).map((l) => [l.name, l.percent]), [['Python', 66.7], ['TypeScript', 33.3]])
})
