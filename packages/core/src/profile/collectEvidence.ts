// What the "Project profiler" agent reads about a repository: languages counted by file, frameworks and package
// managers found in manifests, the modules (workspaces / apps), the folder layout, docs, CI and test setup. Pure and
// deterministic — the API passes in the branch's paths and the contents of the files `profileFilesToRead` picked, so
// the same input always gives the same evidence (and the same hash). Without an AI model the profile is built from
// this alone.

export interface ProfileLanguage {
  name: string
  files: number
  percent: number
}

export interface ProfileModule {
  path: string
  name: string
  kind: string
}

export interface EvidenceDoc {
  path: string
  content: string
}

export interface NodeManifest {
  path: string
  name: string | null
  description: string | null
  scripts: Record<string, string>
  dependencies: string[]
  devDependencies: string[]
  workspaces: string[]
  engines: Record<string, string>
}

export interface ProfileEvidence {
  totalFiles: number
  languages: ProfileLanguage[]
  frameworks: string[]
  packageManagers: string[]
  modules: ProfileModule[]
  /** Top-level folders and files, then each folder's children, with file counts. */
  tree: string[]
  nodeManifests: NodeManifest[]
  /** Other manifests (pyproject, requirements, go.mod, Cargo.toml, *.csproj, pom.xml, Dockerfiles, compose …). */
  manifests: EvidenceDoc[]
  docs: EvidenceDoc[]
  ci: EvidenceDoc[]
  envExamples: EvidenceDoc[]
  /** Config and infrastructure files that exist (contents not read). */
  configs: string[]
  tests: { files: number; folders: string[]; frameworks: string[] }
}

// ─── Picking files ───────────────────────────────────────────────────────────────────────────────

const GENERATED = /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.venv|venv|__pycache__|vendor|target|bin|obj|node_modules)\//i

const MANIFEST =
  /(^|\/)(package\.json|pyproject\.toml|requirements[\w.-]*\.txt|Pipfile|setup\.py|go\.mod|Cargo\.toml|[^/]+\.csproj|[^/]+\.fsproj|pom\.xml|build\.gradle(\.kts)?|composer\.json|Gemfile|pubspec\.yaml|mix\.exs|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/i
const README = /^(?:[^/]+\/){0,2}readme(\.[a-z]+)?$/i
const AGENT_DOCS = /^(CLAUDE\.md|AGENTS\.md|CONTRIBUTING\.md|ARCHITECTURE\.md|\.github\/copilot-instructions\.md)$/i
const DOCS_DIR = /^docs?\/[^/]+\.mdx?$/i
const CI = /^(\.github\/workflows\/[^/]+\.ya?ml|azure-pipelines[^/]*\.ya?ml|\.gitlab-ci\.ya?ml|Jenkinsfile|bitbucket-pipelines\.yml|\.circleci\/config\.yml)$/i
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template|defaults?|dist)$/i
const CONFIG =
  /(^|\/)(tsconfig\.json|turbo\.json|nx\.json|pnpm-workspace\.yaml|lerna\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[^/]*|prettier\.config\.[cm]?[jt]s|biome\.json|ruff\.toml|\.flake8|mypy\.ini|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s|cypress\.config\.[cm]?[jt]s|pytest\.ini|tox\.ini|drizzle\.config\.[jt]s|prisma\/schema\.prisma|next\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|components\.json|vercel\.json|netlify\.toml|fly\.toml|render\.yaml|app\.yaml|serverless\.ya?ml|Procfile|[^/]+\.tf|[^/]+\.bicep|helm\/Chart\.yaml|Chart\.yaml|k8s\/[^/]+\.ya?ml|kubernetes\/[^/]+\.ya?ml|\.devcontainer\/devcontainer\.json|Makefile)$/i
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i

const LIMITS = { nodeManifests: 30, manifests: 25, readmes: 6, docs: 6, ci: 8, env: 4 }

const byDepth = (a: string, b: string) => a.split('/').length - b.split('/').length || a.localeCompare(b)

/** Which of a branch's files the profiler reads (the rest it only counts). */
export function profileFilesToRead(paths: string[]): string[] {
  const usable = paths.filter((p) => !GENERATED.test(p)).sort(byDepth)
  const pick = (re: RegExp, max: number) => usable.filter((p) => re.test(p)).slice(0, max)
  const node = usable.filter((p) => /(^|\/)package\.json$/i.test(p)).slice(0, LIMITS.nodeManifests)
  const other = usable.filter((p) => MANIFEST.test(p) && !/package\.json$/i.test(p)).slice(0, LIMITS.manifests)
  return [
    ...new Set([
      ...node,
      ...other,
      ...pick(README, LIMITS.readmes),
      ...pick(AGENT_DOCS, 5),
      ...pick(DOCS_DIR, LIMITS.docs),
      ...pick(CI, LIMITS.ci),
      ...pick(ENV_EXAMPLE, LIMITS.env),
    ]),
  ]
}

// ─── Languages ───────────────────────────────────────────────────────────────────────────────────

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala',
  cs: 'C#', fs: 'F#', vb: 'Visual Basic', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
  rb: 'Ruby', php: 'PHP', swift: 'Swift', m: 'Objective-C', dart: 'Dart', ex: 'Elixir', exs: 'Elixir',
  sql: 'SQL', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', psm1: 'PowerShell',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'SCSS', less: 'Less', vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  tf: 'HCL', bicep: 'Bicep', lua: 'Lua', r: 'R', jl: 'Julia', hs: 'Haskell', clj: 'Clojure',
}

export function countLanguages(paths: string[]): ProfileLanguage[] {
  const counts = new Map<string, number>()
  let total = 0
  for (const p of paths) {
    if (GENERATED.test(p)) continue
    const ext = p.split('/').pop()?.split('.').slice(1).pop()?.toLowerCase()
    const lang = ext ? LANGUAGES[ext] : undefined
    if (!lang) continue
    counts.set(lang, (counts.get(lang) ?? 0) + 1)
    total += 1
  }
  return [...counts.entries()]
    .map(([name, files]) => ({ name, files, percent: Math.round((files / total) * 1000) / 10 }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
}

// ─── Frameworks and package managers ─────────────────────────────────────────────────────────────

/** Dependency name (exact or prefix*) → what it tells a reader. Order is display order within a project. */
const FRAMEWORKS: Array<[RegExp, string]> = [
  [/^next$/, 'Next.js'], [/^react$/, 'React'], [/^react-native$/, 'React Native'], [/^vue$/, 'Vue'], [/^nuxt$/, 'Nuxt'],
  [/^svelte$|^@sveltejs\/kit$/, 'Svelte'], [/^@angular\/core$/, 'Angular'], [/^solid-js$/, 'Solid'], [/^astro$/, 'Astro'],
  [/^remix$|^@remix-run\//, 'Remix'], [/^vite$/, 'Vite'], [/^electron$/, 'Electron'], [/^@types\/vscode$|^vscode$/, 'VS Code extension API'],
  [/^tailwindcss$/, 'Tailwind CSS'], [/^@radix-ui\//, 'Radix UI'], [/^@mui\/material$/, 'MUI'], [/^@xyflow\/react$|^reactflow$/, 'React Flow'],
  [/^@monaco-editor\/react$|^monaco-editor$/, 'Monaco'], [/^recharts$/, 'Recharts'],
  [/^express$/, 'Express'], [/^fastify$/, 'Fastify'], [/^@nestjs\/core$/, 'NestJS'], [/^koa$/, 'Koa'], [/^hono$/, 'Hono'],
  [/^drizzle-orm$/, 'Drizzle ORM'], [/^prisma$|^@prisma\/client$/, 'Prisma'], [/^typeorm$/, 'TypeORM'], [/^sequelize$/, 'Sequelize'],
  [/^mongoose$/, 'Mongoose'], [/^pg$|^postgres$/, 'PostgreSQL'], [/^mysql2?$/, 'MySQL'], [/^redis$|^ioredis$/, 'Redis'],
  [/^zod$/, 'Zod'], [/^ai$/, 'Vercel AI SDK'], [/^@ai-sdk\/azure$/, 'Azure OpenAI'], [/^openai$/, 'OpenAI SDK'],
  [/^@anthropic-ai\/sdk$/, 'Anthropic SDK'], [/^@langchain\/langgraph$/, 'LangGraph.js'], [/^langchain$|^@langchain\/core$/, 'LangChain'],
  [/^graphql$/, 'GraphQL'], [/^@trpc\/server$/, 'tRPC'], [/^socket\.io$/, 'Socket.IO'],
  [/^vitest$/, 'Vitest'], [/^jest$/, 'Jest'], [/^@playwright\/test$|^playwright$/, 'Playwright'], [/^cypress$/, 'Cypress'],
  [/^mocha$/, 'Mocha'], [/^eslint$/, 'ESLint'], [/^prettier$/, 'Prettier'], [/^@biomejs\/biome$/, 'Biome'],
  [/^turbo$/, 'Turborepo'], [/^nx$/, 'Nx'], [/^esbuild$/, 'esbuild'], [/^webpack$/, 'webpack'],
  // Python
  [/^fastapi$/, 'FastAPI'], [/^django$/, 'Django'], [/^flask$/, 'Flask'], [/^langgraph$/, 'LangGraph'], [/^sqlalchemy$/, 'SQLAlchemy'],
  [/^pydantic$/, 'Pydantic'], [/^uvicorn$/, 'Uvicorn'], [/^psycopg/, 'PostgreSQL'], [/^pytest$/, 'pytest'], [/^ruff$/, 'Ruff'], [/^mypy$/, 'mypy'],
  [/^celery$/, 'Celery'], [/^pandas$/, 'pandas'], [/^numpy$/, 'NumPy'], [/^torch$/, 'PyTorch'], [/^tensorflow$/, 'TensorFlow'],
  // Go / Rust / .NET / Java
  [/^github\.com\/gin-gonic\/gin$/, 'Gin'], [/^github\.com\/labstack\/echo/, 'Echo'], [/^github\.com\/gofiber\/fiber/, 'Fiber'],
  [/^actix-web$/, 'Actix Web'], [/^axum$/, 'Axum'], [/^tokio$/, 'Tokio'], [/^serde$/, 'Serde'],
  [/^microsoft\.aspnetcore/i, 'ASP.NET Core'], [/^microsoft\.entityframeworkcore/i, 'Entity Framework Core'], [/^xunit$/i, 'xUnit'], [/^nunit$/i, 'NUnit'],
  [/^org\.springframework\.boot/, 'Spring Boot'], [/^junit/, 'JUnit'],
]

const TEST_FRAMEWORKS = new Set(['Vitest', 'Jest', 'Playwright', 'Cypress', 'Mocha', 'pytest', 'xUnit', 'NUnit', 'JUnit'])

function frameworksFor(deps: Iterable<string>): string[] {
  const out: string[] = []
  const names = [...deps].map((d) => d.trim()).filter(Boolean)
  for (const [re, label] of FRAMEWORKS) if (names.some((n) => re.test(n)) && !out.includes(label)) out.push(label)
  return out
}

const LOCKFILES: Array<[RegExp, string]> = [
  [/(^|\/)package-lock\.json$/, 'npm'], [/(^|\/)pnpm-lock\.yaml$/, 'pnpm'], [/(^|\/)yarn\.lock$/, 'Yarn'], [/(^|\/)bun\.lockb?$/, 'Bun'],
  [/(^|\/)poetry\.lock$/, 'Poetry'], [/(^|\/)uv\.lock$/, 'uv'], [/(^|\/)Pipfile(\.lock)?$/, 'Pipenv'], [/(^|\/)requirements[\w.-]*\.txt$/, 'pip'],
  [/(^|\/)go\.mod$/, 'Go modules'], [/(^|\/)Cargo\.toml$/, 'Cargo'], [/\.(cs|fs)proj$/, 'NuGet'], [/(^|\/)pom\.xml$/, 'Maven'],
  [/(^|\/)build\.gradle(\.kts)?$/, 'Gradle'], [/(^|\/)composer\.json$/, 'Composer'], [/(^|\/)Gemfile$/, 'Bundler'], [/(^|\/)pubspec\.yaml$/, 'pub'],
]

// ─── Manifest parsing ────────────────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string>
}

export function parseNodeManifest(path: string, text: string): NodeManifest | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  const ws = Array.isArray(o.workspaces)
    ? o.workspaces
    : o.workspaces && typeof o.workspaces === 'object' && Array.isArray((o.workspaces as { packages?: unknown }).packages)
      ? (o.workspaces as { packages: unknown[] }).packages
      : []
  return {
    path,
    name: typeof o.name === 'string' ? o.name : null,
    description: typeof o.description === 'string' ? o.description : null,
    scripts: asRecord(o.scripts),
    dependencies: Object.keys(asRecord(o.dependencies)),
    devDependencies: Object.keys(asRecord(o.devDependencies)),
    workspaces: ws.filter((w): w is string => typeof w === 'string'),
    engines: asRecord(o.engines),
  }
}

/** Dependency names from a non-Node manifest (best effort, line based — never executed). */
export function manifestDependencies(path: string, text: string): string[] {
  const file = path.split('/').pop() ?? path
  const lines = text.split(/\r?\n/)
  if (/^requirements/i.test(file)) return lines.map((l) => l.replace(/#.*/, '').trim().split(/[<>=!~;\s[]/)[0].toLowerCase()).filter(Boolean)
  if (/^pyproject\.toml$/i.test(file)) {
    const quoted = [...text.matchAll(/^\s*"([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*[<>=!~;"]/gm)].map((m) => m[1].toLowerCase())
    const poetry = [...text.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["{]/gm)].map((m) => m[1].toLowerCase()).filter((n) => !['name', 'version', 'description', 'python', 'readme', 'requires-python', 'license'].includes(n))
    return [...new Set([...quoted, ...poetry])]
  }
  if (/^go\.mod$/i.test(file)) return [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v/gm)].map((m) => m[1])
  if (/^Cargo\.toml$/i.test(file)) {
    const deps = text.split(/^\[(?:dev-)?dependencies\]\s*$/m).slice(1).map((s) => s.split(/^\[/m)[0]).join('\n')
    return [...deps.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1])
  }
  if (/\.(cs|fs)proj$/i.test(file)) return [...text.matchAll(/PackageReference\s+Include="([^"]+)"/g)].map((m) => m[1].toLowerCase())
  if (/^pom\.xml$/i.test(file)) return [...text.matchAll(/<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/g)].map((m) => `${m[1]}.${m[2]}`)
  if (/^build\.gradle/i.test(file)) return [...text.matchAll(/['"]([\w.-]+):([\w.-]+):[^'"]*['"]/g)].map((m) => `${m[1]}.${m[2]}`)
  return []
}

function moduleOf(path: string, text: string): ProfileModule | null {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'
  const file = path.split('/').pop() ?? path
  const nameIn = (re: RegExp) => text.match(re)?.[1] ?? null
  if (/^pyproject\.toml$/i.test(file)) return { path: dir, name: nameIn(/^\s*name\s*=\s*"([^"]+)"/m) ?? dir, kind: 'python' }
  if (/^go\.mod$/i.test(file)) return { path: dir, name: nameIn(/^module\s+(\S+)/m) ?? dir, kind: 'go' }
  if (/^Cargo\.toml$/i.test(file)) return { path: dir, name: nameIn(/^\s*name\s*=\s*"([^"]+)"/m) ?? dir, kind: 'rust' }
  if (/\.(cs|fs)proj$/i.test(file)) return { path: dir, name: file.replace(/\.(cs|fs)proj$/i, ''), kind: 'dotnet' }
  if (/^pom\.xml$/i.test(file)) return { path: dir, name: nameIn(/<artifactId>([^<]+)<\/artifactId>/) ?? dir, kind: 'java' }
  return null
}

// ─── Layout ──────────────────────────────────────────────────────────────────────────────────────

export function folderTree(paths: string[], maxChildren = 12): string[] {
  const top = new Map<string, { files: number; children: Map<string, number> }>()
  const rootFiles: string[] = []
  for (const p of paths) {
    if (GENERATED.test(p)) continue
    const parts = p.split('/')
    if (parts.length === 1) {
      rootFiles.push(p)
      continue
    }
    const entry = top.get(parts[0]) ?? { files: 0, children: new Map<string, number>() }
    entry.files += 1
    if (parts.length > 2) entry.children.set(parts[1], (entry.children.get(parts[1]) ?? 0) + 1)
    top.set(parts[0], entry)
  }
  const lines: string[] = []
  for (const [dir, e] of [...top.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${dir}/ (${e.files} files)`)
    const kids = [...e.children.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxChildren)
    for (const [kid, n] of kids) lines.push(`  ${dir}/${kid}/ (${n})`)
    if (e.children.size > maxChildren) lines.push(`  … ${e.children.size - maxChildren} more folders`)
  }
  if (rootFiles.length) lines.push(`(root files) ${rootFiles.sort().slice(0, 30).join(', ')}`)
  return lines
}

// ─── Collect ─────────────────────────────────────────────────────────────────────────────────────

/** Build the evidence from every path on the branch and the contents of the files `profileFilesToRead` chose. */
export function collectProfileEvidence(paths: string[], contents: ReadonlyMap<string, string>): ProfileEvidence {
  const usable = paths.filter((p) => !GENERATED.test(p))
  const read = [...contents.entries()].sort((a, b) => byDepth(a[0], b[0]))

  const nodeManifests = read
    .filter(([p]) => /(^|\/)package\.json$/i.test(p))
    .map(([p, t]) => parseNodeManifest(p, t))
    .filter((m): m is NodeManifest => m !== null)
  const otherManifests = read.filter(([p]) => MANIFEST.test(p) && !/package\.json$/i.test(p))

  const deps = new Set<string>()
  for (const m of nodeManifests) for (const d of [...m.dependencies, ...m.devDependencies]) deps.add(d)
  for (const [p, t] of otherManifests) for (const d of manifestDependencies(p, t)) deps.add(d)
  const frameworks = frameworksFor(deps)
  if (usable.some((p) => /(^|\/)Dockerfile[^/]*$/i.test(p))) frameworks.push('Docker')
  if (usable.some((p) => /\.tf$/i.test(p))) frameworks.push('Terraform')
  if (usable.some((p) => /\.bicep$/i.test(p))) frameworks.push('Bicep')

  const packageManagers: string[] = []
  for (const [re, label] of LOCKFILES) if (usable.some((p) => re.test(p)) && !packageManagers.includes(label)) packageManagers.push(label)
  // A package.json without a lockfile still means npm-compatible tooling.
  if (nodeManifests.length && !packageManagers.some((m) => ['npm', 'pnpm', 'Yarn', 'Bun'].includes(m))) packageManagers.unshift('npm')

  const modules: ProfileModule[] = []
  for (const m of nodeManifests) {
    const dir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : '.'
    modules.push({ path: dir, name: m.name ?? dir, kind: dir === '.' && m.workspaces.length ? 'workspace root' : 'node' })
  }
  for (const [p, t] of otherManifests) {
    const mod = moduleOf(p, t)
    if (mod && !modules.some((x) => x.path === mod.path && x.kind === mod.kind)) modules.push(mod)
  }

  const testFiles = usable.filter((p) => TEST_FILE.test(p))
  const testFolders = [...new Set(testFiles.map((p) => p.split('/').slice(0, 2).join('/')).filter((p) => p.includes('/')))].slice(0, 12)

  const docs = read.filter(([p]) => README.test(p) || AGENT_DOCS.test(p) || DOCS_DIR.test(p)).map(([path, content]) => ({ path, content }))
  const ci = read.filter(([p]) => CI.test(p)).map(([path, content]) => ({ path, content }))
  const envExamples = read.filter(([p]) => ENV_EXAMPLE.test(p)).map(([path, content]) => ({ path, content }))

  return {
    totalFiles: usable.length,
    languages: countLanguages(usable),
    frameworks,
    packageManagers,
    modules: modules.slice(0, 40),
    tree: folderTree(usable),
    nodeManifests,
    manifests: otherManifests.map(([path, content]) => ({ path, content })),
    docs,
    ci,
    envExamples,
    configs: usable.filter((p) => CONFIG.test(p)).slice(0, 60),
    tests: { files: testFiles.length, folders: testFolders, frameworks: frameworks.filter((f) => TEST_FRAMEWORKS.has(f)) },
  }
}

// ─── Render for the model ────────────────────────────────────────────────────────────────────────

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}\n… (truncated)` : text)

/** Names only, so secrets in an example file never reach the model. */
export function envVarNames(text: string): string[] {
  return [...new Set([...text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]))]
}

/** The evidence as Markdown for the model, within `budget` characters. Deterministic. */
export function renderProfileEvidence(e: ProfileEvidence, budget = 60_000): string {
  const out: string[] = []
  out.push('## Repository facts (counted)')
  out.push(`Files: ${e.totalFiles}`)
  out.push(`Languages: ${e.languages.slice(0, 10).map((l) => `${l.name} ${l.percent}% (${l.files})`).join(', ') || 'none detected'}`)
  out.push(`Frameworks and libraries: ${e.frameworks.join(', ') || 'none detected'}`)
  out.push(`Package managers: ${e.packageManagers.join(', ') || 'none detected'}`)
  out.push(`Tests: ${e.tests.files} test files${e.tests.folders.length ? ` in ${e.tests.folders.join(', ')}` : ''}${e.tests.frameworks.length ? `; frameworks ${e.tests.frameworks.join(', ')}` : ''}`)
  if (e.configs.length) out.push(`Config and infrastructure files: ${e.configs.join(', ')}`)
  out.push('', '## Folder layout', ...e.tree.slice(0, 120))

  if (e.modules.length) {
    out.push('', '## Modules')
    for (const m of e.modules) out.push(`- ${m.path} — ${m.name} (${m.kind})`)
  }

  if (e.nodeManifests.length) {
    out.push('', '## package.json manifests')
    for (const m of e.nodeManifests) {
      out.push(`### ${m.path}${m.name ? ` — ${m.name}` : ''}`)
      if (m.description) out.push(`Description: ${m.description}`)
      if (m.workspaces.length) out.push(`Workspaces: ${m.workspaces.join(', ')}`)
      if (Object.keys(m.engines).length) out.push(`Engines: ${Object.entries(m.engines).map(([k, v]) => `${k} ${v}`).join(', ')}`)
      const scripts = Object.entries(m.scripts).slice(0, 25)
      if (scripts.length) out.push('Scripts:', ...scripts.map(([k, v]) => `- ${k}: ${clip(v, 160)}`))
      if (m.dependencies.length) out.push(`Dependencies: ${m.dependencies.slice(0, 60).join(', ')}`)
      if (m.devDependencies.length) out.push(`Dev dependencies: ${m.devDependencies.slice(0, 40).join(', ')}`)
    }
  }

  if (e.envExamples.length) {
    out.push('', '## Environment variables (names from example files)')
    for (const d of e.envExamples) out.push(`- ${d.path}: ${envVarNames(d.content).join(', ') || '(none)'}`)
  }
  // Documentation last: it is the largest part and the first the budget cuts (the root README comes first).
  const sections: Array<[string, EvidenceDoc[], number]> = [
    ['CI pipelines', e.ci, 2_000],
    ['Other manifests', e.manifests, 2_500],
    ['Documentation', e.docs, 6_000],
  ]
  for (const [title, docs, max] of sections) {
    if (!docs.length) continue
    out.push('', `## ${title}`)
    for (const d of docs) out.push(`### ${d.path}`, '```', clip(d.content.trim(), max), '```')
  }
  const text = out.join('\n')
  return text.length > budget ? `${text.slice(0, budget).trimEnd()}\n… (evidence truncated)` : text
}
