// Import a repository's agents and skills into the project's catalog. Runs on the default branch after a sync,
// using the same pure discovery adapters as the VS Code extension (@sdlc/core/discovery): Claude agents and
// skills, AGENTS.md, agent.yaml, Copilot instructions and agents, Cursor rules. Definitions are parsed, never run.

import { createHash } from 'crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import picomatch from 'picomatch'
import {
  ADAPTERS,
  agentKindOf,
  asString,
  normalize,
  parseYamlDocument,
  slug as slugify,
  splitFrontmatter,
  type InternalAgent,
  type SourceKind,
} from '@sdlc/core/discovery'
import type { RepoCatalogStats } from '@sdlc/contracts'
import { writeAudit } from '../audit'
import { agents, projectAgents, projects, repoBlobs, repoFiles, workflows } from '../db/schema'
import type { BranchRow } from './indexer'
import type { RepoRow, RepoRuntime } from './runtime'

export interface CatalogImportResult {
  stats: RepoCatalogStats
  /** Whether any agent row was added, changed or removed. */
  changed: boolean
}

/** Catalog category for each convention, when the definition doesn't name one. */
const CATEGORY: Record<SourceKind, string> = {
  'claude-agent': 'Claude Code',
  'claude-skill': 'Claude skill',
  'agents-md': 'AGENTS.md',
  'agent-yaml': 'Agent YAML',
  'copilot-instructions': 'Copilot',
  'copilot-agent': 'Copilot',
  'cursor-rules': 'Cursor',
}

const REMOVED_ISSUE = 'Removed from the repository — kept because a workflow step still uses it.'

const MATCHERS = ADAPTERS.map((adapter) => ({ adapter, isMatch: picomatch([...adapter.globs], { dot: true }) }))

/** Which adapters claim a repo path (exported for tests). */
export function adaptersFor(path: string): typeof ADAPTERS[number][] {
  return MATCHERS.filter((m) => m.isMatch(path)).map((m) => m.adapter)
}

export interface CatalogRow {
  slug: string
  agent: InternalAgent
}

/**
 * Give every discovered definition a catalog slug. Built-in slugs are reserved (a repo "planner" becomes
 * "repo-planner") so `/agents/:slug` lookups and workflow bindings stay unambiguous; agents are named first, so
 * a skill sharing an agent's name becomes "<name>-skill". Exported for tests.
 */
export function assignSlugs(found: InternalAgent[], builtinSlugs: Set<string>): CatalogRow[] {
  const ordered = [...found].sort((a, b) => {
    const ka = agentKindOf(a.sourceKind) === 'agent' ? 0 : 1
    const kb = agentKindOf(b.sourceKind) === 'agent' ? 0 : 1
    return ka - kb || a.sourcePath.localeCompare(b.sourcePath)
  })
  const used = new Set<string>()
  const out: CatalogRow[] = []
  for (const agent of ordered) {
    const base = slugify(agent.name) || slugify(agent.sourcePath.split('/').pop() ?? '') || 'agent'
    let s = builtinSlugs.has(base) ? `repo-${base}` : base
    if (used.has(s) && agentKindOf(agent.sourceKind) === 'skill') s = `${s}-skill`
    let n = 2
    const stem = s
    while (used.has(s) || builtinSlugs.has(s)) s = `${stem}-${n++}`
    used.add(s)
    out.push({ slug: s, agent })
  }
  return out
}

function metaOf(agent: InternalAgent): Record<string, unknown> {
  if (agent.sourceKind === 'agent-yaml') return parseYamlDocument(agent.raw) ?? {}
  return splitFrontmatter(agent.raw).meta
}

/**
 * Bring the project's repo agents in line with `branch` (null = the repository is empty or gone: remove them).
 * New definitions start enabled when they parsed cleanly, disabled when they need attention; existing ones keep
 * their switch. Definitions that disappeared are removed — unless a workflow step still uses one, which is kept
 * and flagged.
 */
export async function importRepoCatalog(
  rt: RepoRuntime,
  args: { repo: Pick<RepoRow, 'id' | 'projectId'>; branch: BranchRow | null; requestedBy: string | null; via: string },
): Promise<CatalogImportResult> {
  const { db } = rt
  const { repo, branch } = args
  const [project] = await db.select({ id: projects.id, orgId: projects.orgId }).from(projects).where(eq(projects.id, repo.projectId)).limit(1)
  if (!project) return { stats: { agents: 0, skills: 0, added: 0, updated: 0, removed: 0 }, changed: false }

  // 1. Find and parse definition files on the branch.
  let found: InternalAgent[] = []
  if (branch) {
    const files = await db
      .select({ path: repoFiles.path, blobSha: repoFiles.blobSha })
      .from(repoFiles)
      .where(and(eq(repoFiles.branchId, branch.id), eq(repoFiles.type, 'file'), eq(repoFiles.status, 'stored')))
    const candidates = files.map((f) => ({ ...f, adapters: adaptersFor(f.path) })).filter((f) => f.adapters.length > 0 && f.blobSha)
    const shas = [...new Set(candidates.map((c) => c.blobSha as string))]
    const contents = new Map<string, string>()
    for (let i = 0; i < shas.length; i += 1000) {
      const rows = await db
        .select({ sha: repoBlobs.sha, content: repoBlobs.content })
        .from(repoBlobs)
        .where(and(eq(repoBlobs.repositoryId, repo.id), inArray(repoBlobs.sha, shas.slice(i, i + 1000))))
      for (const r of rows) contents.set(r.sha, r.content)
    }
    const raw = candidates.flatMap((c) => {
      const text = contents.get(c.blobSha as string)
      return text === undefined ? [] : c.adapters.flatMap((a) => a.parse(c.path, text))
    })
    found = normalize(raw, { byKind: true }).filter((a) => a.status !== 'skipped')
  }

  const builtin = new Set((await db.select({ slug: agents.slug }).from(agents).where(isNull(agents.projectId))).map((r) => r.slug))
  const rows = assignSlugs(found, builtin)

  // 2. Reconcile with what the catalog holds.
  const existing = await db.select().from(agents).where(and(eq(agents.projectId, project.id), eq(agents.source, 'repo')))
  const projectWorkflows = await db.select({ spec: workflows.spec }).from(workflows).where(eq(workflows.projectId, project.id))
  const usedSlugs = new Set(
    projectWorkflows.flatMap((w) => w.spec.nodes.filter((n) => n.kind === 'agent' && typeof n.data.agentId === 'string').map((n) => n.data.agentId as string)),
  )

  let added = 0
  let updated = 0
  let removed = 0
  await db.transaction(async (tx) => {
    const seen = new Set<string>()
    for (const { slug, agent } of rows) {
      const meta = metaOf(agent)
      const values = {
        slug,
        source: 'repo' as const,
        kind: agentKindOf(agent.sourceKind),
        projectId: project.id,
        branch: branch!.name,
        contentHash: createHash('sha256').update(`${agent.sourcePath}\n${agent.raw}`).digest('hex'),
        minProjectRole: null,
        name: agent.name.slice(0, 200),
        description: agent.description.slice(0, 2000),
        category: (asString(meta.category) || CATEGORY[agent.sourceKind]).slice(0, 80),
        sdlcStage: (asString(meta.sdlcStage ?? meta.sdlc_stage) || 'any').slice(0, 40),
        executionTarget: 'local' as const,
        tools: agent.tools.slice(0, 100),
        instructions: agent.instructions,
        sourcePath: agent.sourcePath,
        model: agent.model ?? null,
        issues: agent.issues,
      }
      const current = existing.find((e) => e.branch === values.branch && e.slug === slug)
      if (current) {
        seen.add(current.id)
        const same =
          current.contentHash === values.contentHash &&
          current.kind === values.kind &&
          JSON.stringify(current.issues) === JSON.stringify(values.issues)
        if (!same) {
          await tx.update(agents).set(values).where(eq(agents.id, current.id))
          updated++
        }
      } else {
        const [created] = await tx.insert(agents).values(values).returning({ id: agents.id })
        await tx
          .insert(projectAgents)
          .values({ projectId: project.id, agentId: created.id, enabled: agent.status === 'valid' })
          .onConflictDoNothing()
        added++
      }
    }
    for (const e of existing) {
      if (seen.has(e.id)) continue
      if (usedSlugs.has(e.slug)) {
        if (!e.issues.includes(REMOVED_ISSUE)) {
          await tx.update(agents).set({ issues: [...e.issues, REMOVED_ISSUE] }).where(eq(agents.id, e.id))
          removed++
        }
      } else {
        await tx.delete(agents).where(eq(agents.id, e.id))
        removed++
      }
    }
    if (added + updated + removed > 0) {
      await writeAudit(tx, {
        orgId: project.orgId,
        projectId: project.id,
        actorUserId: args.requestedBy,
        action: 'agents.synced',
        resourceType: 'repository',
        resourceId: repo.id,
        data: { branch: branch?.name ?? null, added, updated, removed },
        via: args.via,
      })
    }
  })

  return {
    stats: {
      agents: rows.filter((r) => agentKindOf(r.agent.sourceKind) === 'agent').length,
      skills: rows.filter((r) => agentKindOf(r.agent.sourceKind) === 'skill').length,
      added,
      updated,
      removed,
    },
    changed: added + updated + removed > 0,
  }
}
