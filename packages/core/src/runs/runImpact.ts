// What a run's changes touch, worked out from its changed files alone: the areas of the codebase, what kind of
// files they are, and the changes a reviewer should look at first (migrations, CI, secrets, dependencies, big
// deletions, code changed without tests). Pure and deterministic — the web app draws it, the API feeds it to the
// AI summary.

/** The parts of a changed file this needs (a subset of the contracts' ChangedFile). */
export interface ImpactFile {
  path: string
  oldPath?: string
  status: string
  additions: number
  deletions: number
  binary?: boolean
  excluded?: boolean
}

export const IMPACT_CATEGORIES = ['source', 'tests', 'ui', 'api', 'database', 'dependencies', 'config', 'ci', 'docs', 'assets'] as const
export type ImpactCategory = (typeof IMPACT_CATEGORIES)[number]

export const IMPACT_CATEGORY_LABELS: Record<ImpactCategory, string> = {
  source: 'Source',
  tests: 'Tests',
  ui: 'UI',
  api: 'API',
  database: 'Database',
  dependencies: 'Dependencies',
  config: 'Config',
  ci: 'CI / pipelines',
  docs: 'Docs',
  assets: 'Assets',
}

export const RISK_IDS = ['secrets', 'migration', 'security', 'ci', 'dependencies', 'large_change', 'large_deletion', 'deleted_files', 'untested', 'binary'] as const
export type RiskId = (typeof RISK_IDS)[number]
export type RiskSeverity = 'high' | 'medium' | 'low'

export interface RiskFlag {
  id: RiskId
  severity: RiskSeverity
  label: string
  detail: string
  files: string[]
}

export interface ImpactArea {
  area: string
  files: number
  additions: number
  deletions: number
}

export interface ImpactCategoryTotal {
  category: ImpactCategory
  files: number
  additions: number
  deletions: number
}

export type ChangeSize = 'none' | 'xs' | 's' | 'm' | 'l' | 'xl'

export interface RunImpact {
  files: number
  additions: number
  deletions: number
  size: ChangeSize
  byStatus: { added: number; modified: number; deleted: number; renamed: number; other: number }
  /** Largest first (by lines changed). */
  areas: ImpactArea[]
  /** Largest first (by lines changed). */
  categories: ImpactCategoryTotal[]
  /** Most severe first. */
  risks: RiskFlag[]
}

const TEST = /(^|\/)(tests?|__tests__|__mocks__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|Tests?\.cs$/i
const CI = /^\.github\/workflows\/|(^|\/)azure-pipelines[^/]*\.ya?ml$|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)Jenkinsfile$|^\.circleci\/|^\.azure-pipelines\//i
const DEPENDENCIES =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|[^/]+\.csproj|packages\.config|Directory\.Packages\.props)$/i
const DATABASE = /(^|\/)(migrations?|drizzle|alembic|flyway|liquibase)\/|\.sql$|(^|\/)schema\.prisma$|(^|\/)db\/schema[^/]*$/i
const MIGRATION = /(^|\/)(migrations?|drizzle|alembic|flyway|liquibase)\/.+|\.sql$/i
const DOCS = /\.(md|mdx|rst|adoc|txt)$|^docs?\//i
const CONFIG =
  /(^|\/)\.[^/]+$|(^|\/)(tsconfig[^/]*\.json|[^/]+\.config\.[cm]?[jt]s|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|Makefile|[^/]+\.(ya?ml|toml|ini|cfg|conf|properties|env))$/i
const UI = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html?)$|(^|\/)(components|pages|views|app|ui|styles)\//i
const API = /(^|\/)(routes?|controllers?|api|handlers?|endpoints?|routers?|resolvers?)\/|Routes?\.[cm]?[jt]s$|Controller\.(cs|java|ts)$/i
const ASSETS = /\.(png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|mov|pdf|zip)$/i
const SECRETS = /(^|\/)\.env(\.[^/]*)?$|\.(pem|key|p12|pfx|jks|keystore)$|(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$|(^|\/)(credentials|secrets?)(\.[^/]+)?$/i
const SECURITY = /(^|\/|[._-])(auth\w*|security|permissions?|rbac|acl|crypto|secrets?|tokens?|passwords?|sessions?|oauth|login|signin|jwt|csrf|cors)([/._-]|$)/i
const ENV_EXAMPLE = /\.env\.(example|sample|template)$/i

/** The kind of file a path is. First match wins, so a `.test.tsx` file is a test, not UI. */
export function impactCategory(path: string): ImpactCategory {
  const p = path.replace(/\\/g, '/')
  if (TEST.test(p)) return 'tests'
  if (CI.test(p)) return 'ci'
  if (DEPENDENCIES.test(p)) return 'dependencies'
  if (DATABASE.test(p)) return 'database'
  if (ASSETS.test(p)) return 'assets'
  if (DOCS.test(p)) return 'docs'
  if (CONFIG.test(p)) return 'config'
  if (API.test(p)) return 'api'
  if (UI.test(p)) return 'ui'
  return 'source'
}

/** The part of the codebase a path is in: its first two folders (`apps/web`), its folder, or `(root)`. */
export function impactArea(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`
  if (parts.length === 2) return parts[0]
  return '(root)'
}

export function changeSize(lines: number): ChangeSize {
  if (lines <= 0) return 'none'
  if (lines < 10) return 'xs'
  if (lines < 50) return 's'
  if (lines < 250) return 'm'
  if (lines < 1000) return 'l'
  return 'xl'
}

const SEVERITY_ORDER: Record<RiskSeverity, number> = { high: 0, medium: 1, low: 2 }
const MAX_RISK_FILES = 20

function lines(f: ImpactFile): number {
  return f.additions + f.deletions
}

/** Areas, kinds of files and review flags for a run's changed files. */
export function classifyRunImpact(files: readonly ImpactFile[]): RunImpact {
  const byStatus = { added: 0, modified: 0, deleted: 0, renamed: 0, other: 0 }
  const areas = new Map<string, ImpactArea>()
  const categories = new Map<ImpactCategory, ImpactCategoryTotal>()
  const hits: Record<RiskId, string[]> = {
    secrets: [],
    migration: [],
    security: [],
    ci: [],
    dependencies: [],
    large_change: [],
    large_deletion: [],
    deleted_files: [],
    untested: [],
    binary: [],
  }
  let additions = 0
  let deletions = 0
  let testsChanged = false
  const codeChanged: string[] = []

  for (const f of files) {
    const path = f.path.replace(/\\/g, '/')
    additions += f.additions
    deletions += f.deletions
    if (f.status === 'added' || f.status === 'untracked') byStatus.added++
    else if (f.status === 'modified' || f.status === 'type_changed') byStatus.modified++
    else if (f.status === 'deleted') byStatus.deleted++
    else if (f.status === 'renamed' || f.status === 'copied') byStatus.renamed++
    else byStatus.other++

    const areaKey = impactArea(path)
    const area = areas.get(areaKey) ?? { area: areaKey, files: 0, additions: 0, deletions: 0 }
    area.files++
    area.additions += f.additions
    area.deletions += f.deletions
    areas.set(areaKey, area)

    const category = impactCategory(path)
    const total = categories.get(category) ?? { category, files: 0, additions: 0, deletions: 0 }
    total.files++
    total.additions += f.additions
    total.deletions += f.deletions
    categories.set(category, total)

    if (category === 'tests') testsChanged = true
    if ((category === 'source' || category === 'api' || category === 'ui') && f.additions > 0) codeChanged.push(path)
    if (SECRETS.test(path) && !ENV_EXAMPLE.test(path)) hits.secrets.push(path)
    if (category === 'database' && MIGRATION.test(path)) hits.migration.push(path)
    if (category !== 'tests' && category !== 'docs' && SECURITY.test(path)) hits.security.push(path)
    if (category === 'ci') hits.ci.push(path)
    if (category === 'dependencies') hits.dependencies.push(path)
    if (f.status === 'deleted') hits.deleted_files.push(path)
    if (f.deletions >= 150) hits.large_deletion.push(path)
    if (f.binary && category !== 'assets') hits.binary.push(path)
  }

  const total = additions + deletions
  if (total >= 1000 || files.length >= 50) hits.large_change.push(...[...files].sort((a, b) => lines(b) - lines(a)).slice(0, 5).map((f) => f.path))
  if (deletions >= 300 && hits.large_deletion.length === 0) hits.large_deletion.push(...[...files].sort((a, b) => b.deletions - a.deletions).slice(0, 3).map((f) => f.path))
  if (!testsChanged && codeChanged.length > 0) hits.untested.push(...codeChanged)

  const risks: RiskFlag[] = []
  const add = (id: RiskId, severity: RiskSeverity, label: string, detail: (n: number) => string) => {
    const list = hits[id]
    if (list.length) risks.push({ id, severity, label, detail: detail(list.length), files: list.slice(0, MAX_RISK_FILES) })
  }
  const filesWord = (n: number) => `${n} file${n === 1 ? '' : 's'}`
  add('secrets', 'high', 'Possible secrets', (n) => `${filesWord(n)} that usually hold credentials changed. Make sure nothing secret is committed.`)
  add('migration', 'high', 'Database migration', (n) => `${filesWord(n)} change the database schema or data. Review before it reaches a shared database.`)
  add('security', 'medium', 'Security-sensitive code', (n) => `${filesWord(n)} in authentication, permissions or secrets handling.`)
  add('ci', 'medium', 'CI / pipeline change', (n) => `${filesWord(n)} change how the project is built or deployed.`)
  add('dependencies', 'medium', 'Dependencies changed', (n) => `${filesWord(n)} add, remove or upgrade packages.`)
  add('large_change', 'medium', 'Large change', () => `${total.toLocaleString('en-US')} lines across ${filesWord(files.length)}. Consider reviewing it in parts.`)
  add('large_deletion', 'medium', 'Large deletion', () => `${deletions.toLocaleString('en-US')} lines removed.`)
  add('deleted_files', 'low', 'Files deleted', (n) => `${filesWord(n)} removed.`)
  add('untested', 'low', 'No tests changed', (n) => `${filesWord(n)} of code changed, but no test files did.`)
  add('binary', 'low', 'Binary files', (n) => `${filesWord(n)} can't be reviewed as text.`)
  risks.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  const byLines = <T extends { additions: number; deletions: number; files: number }>(a: T, b: T) =>
    b.additions + b.deletions - (a.additions + a.deletions) || b.files - a.files
  return {
    files: files.length,
    additions,
    deletions,
    size: changeSize(total),
    byStatus,
    areas: [...areas.values()].sort(byLines),
    categories: [...categories.values()].sort(byLines),
    risks,
  }
}
