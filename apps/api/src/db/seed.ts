// Seeds a local database (idempotent — safe to re-run):
//   • the organization and one local user per role, for the dev sign-in
//   • the platform workflow template: the "Story delivery" workflow (@sdlc/core, agent steps bound to the built-ins), which also replaces
//     the retired SDLC Default / SDLC Governance templates in every existing project
//   • two demo projects with members and stories, created through the same services the API uses
//   • the built-in agents (seedAgents.ts), enabled in every project and bound to the template's agent steps

import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { ProjectRole, StoryPriority } from '@sdlc/contracts'
import type { AuthUser } from '../auth'
import { loadConfig } from '../config'
import { EventBus } from '../events'
import type { Caller, ServiceDeps } from '../services/context'
import { addMember, createProject, removeMember } from '../services/projects'
import { assignStory, createStory, transitionStory } from '../services/stories'
import { createDb, type Db } from './client'
import { organizations, projects, users, workflows } from './schema'
import { seedBuiltinAgents } from './seedAgents'
import { seedDemoMemory } from './seedMemory'
import { QUICK_FIX_SPEC, RETIRED_TEMPLATE_NAMES, STORY_DELIVERY_SPEC } from './templates/storyDeliverySpec'

// ─── Users ───────────────────────────────────────────────────────────────────────────────────────

const SEED_USERS = [
  { email: 'admin@sdlc.local', displayName: 'Asha Admin', orgRole: 'org_admin' as const },
  { email: 'owner@sdlc.local', displayName: 'Owen Owner', orgRole: 'member' as const },
  { email: 'lead@sdlc.local', displayName: 'Leela Lead', orgRole: 'member' as const },
  { email: 'dev1@sdlc.local', displayName: 'Devi Developer', orgRole: 'member' as const },
  { email: 'dev2@sdlc.local', displayName: 'Deepak Developer', orgRole: 'member' as const },
  { email: 'viewer@sdlc.local', displayName: 'Vera Viewer', orgRole: 'member' as const },
]

// ─── Workflow templates ──────────────────────────────────────────────────────────────────────────

/**
 * Make "Story delivery" the only platform template, and swap the retired templates for it in every project (as
 * the project's default). Returns how many project workflows were replaced.
 */
async function seedWorkflowTemplates(db: Db): Promise<number> {
  const spec = STORY_DELIVERY_SPEC
  const [existing] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(isNull(workflows.projectId), eq(workflows.name, spec.name)))
    .limit(1)
  if (existing) {
    await db.update(workflows).set({ spec, description: spec.description, isDefault: true }).where(eq(workflows.id, existing.id))
  } else {
    await db.insert(workflows).values({ projectId: null, name: spec.name, description: spec.description, isDefault: true, spec })
  }
  await db.delete(workflows).where(and(isNull(workflows.projectId), inArray(workflows.name, RETIRED_TEMPLATE_NAMES)))

  // Project copies nobody has edited yet (still version 1) pick up the current template — e.g. the agent bindings.
  await db
    .update(workflows)
    .set({ spec, description: spec.description })
    .where(and(isNotNull(workflows.projectId), eq(workflows.name, spec.name), eq(workflows.version, 1)))

  // Projects created before the switch still hold copies of the retired templates.
  const retired = await db
    .select({ id: workflows.id, projectId: workflows.projectId })
    .from(workflows)
    .where(and(isNotNull(workflows.projectId), inArray(workflows.name, RETIRED_TEMPLATE_NAMES)))
  const projectIds = [...new Set(retired.map((w) => w.projectId as string))]
  for (const projectId of projectIds) {
    await db.transaction(async (tx) => {
      await tx.delete(workflows).where(and(eq(workflows.projectId, projectId), inArray(workflows.name, RETIRED_TEMPLATE_NAMES)))
      const [hasSkeleton] = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.projectId, projectId), eq(workflows.name, spec.name)))
        .limit(1)
      if (!hasSkeleton) {
        const [hasDefault] = await tx
          .select({ id: workflows.id })
          .from(workflows)
          .where(and(eq(workflows.projectId, projectId), eq(workflows.isDefault, true)))
          .limit(1)
        await tx
          .insert(workflows)
          .values({ projectId, name: spec.name, description: spec.description, isDefault: !hasDefault, spec })
      }
    })
  }
  return retired.length
}

/**
 * The "Quick fix" template (runs started from a prompt, no story): upsert it, and add a copy to every project that
 * does not have one yet. Never the default — Story delivery stays the default for stories.
 */
async function seedQuickFixTemplate(db: Db): Promise<number> {
  const spec = QUICK_FIX_SPEC
  const [existing] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(isNull(workflows.projectId), eq(workflows.name, spec.name)))
    .limit(1)
  if (existing) await db.update(workflows).set({ spec, description: spec.description, isDefault: false }).where(eq(workflows.id, existing.id))
  else await db.insert(workflows).values({ projectId: null, name: spec.name, description: spec.description, isDefault: false, spec })

  // Unedited project copies pick up the current template.
  await db
    .update(workflows)
    .set({ spec, description: spec.description })
    .where(and(isNotNull(workflows.projectId), eq(workflows.name, spec.name), eq(workflows.version, 1)))

  const missing = await db
    .select({ id: projects.id })
    .from(projects)
    .where(sql`not exists (select 1 from ${workflows} w where w.project_id = ${projects.id} and w.name = ${spec.name})`)
  if (missing.length > 0) {
    await db.insert(workflows).values(missing.map((p) => ({ projectId: p.id, name: spec.name, description: spec.description, isDefault: false, spec })))
  }
  return missing.length
}

// ─── Demo projects ───────────────────────────────────────────────────────────────────────────────

interface DemoStory {
  title: string
  description: string
  criteria: string[]
  priority: StoryPriority
  /** Where the story should end up, and who works on it. */
  status: 'draft' | 'ready' | 'in_progress' | 'in_review' | 'done'
  assignee?: string
}

interface DemoProject {
  key: string
  name: string
  description: string
  members: Array<{ email: string; role: ProjectRole }>
  storyAuthor: string
  stories: DemoStory[]
}

const DEMO_PROJECTS: DemoProject[] = [
  {
    key: 'PAY',
    name: 'Payments Portal',
    description: 'Customer-facing payments: checkout, refunds, saved cards and receipts.',
    members: [
      { email: 'owner@sdlc.local', role: 'owner' },
      { email: 'lead@sdlc.local', role: 'lead' },
      { email: 'dev1@sdlc.local', role: 'developer' },
      { email: 'dev2@sdlc.local', role: 'developer' },
      { email: 'viewer@sdlc.local', role: 'viewer' },
    ],
    storyAuthor: 'lead@sdlc.local',
    stories: [
      {
        title: 'Card payment checkout',
        description: 'As a customer, I want to pay for my order with a debit or credit card so that I can complete checkout without leaving the site.',
        criteria: [
          'Visa, Mastercard and RuPay cards are accepted',
          'Card details are tokenised; the raw card number never reaches our servers',
          'A failed payment shows the reason and lets the customer retry',
        ],
        priority: 'high',
        status: 'ready',
      },
      {
        title: 'Refund API endpoint',
        description: 'As a support agent, I want to refund all or part of a payment so that I can resolve customer complaints quickly.',
        criteria: ['Full and partial refunds are supported', 'A refund can never exceed the captured amount', 'Every refund is audit-logged'],
        priority: 'high',
        status: 'in_progress',
        assignee: 'dev1@sdlc.local',
      },
      {
        title: 'Payment receipt email',
        description: 'As a customer, I want an email receipt after paying so that I have a record of the transaction.',
        criteria: ['Sent within one minute of a successful payment', 'Shows the amount, the last four card digits and the order number'],
        priority: 'medium',
        status: 'draft',
      },
      {
        title: 'PCI audit logging',
        description: 'As a compliance officer, I want every access to payment data logged so that we can pass the PCI DSS audit.',
        criteria: ['Each read of payment data records who, when and why', 'Logs are append-only and kept for one year'],
        priority: 'critical',
        status: 'in_review',
        assignee: 'dev2@sdlc.local',
      },
      {
        title: 'Saved cards management',
        description: 'As a returning customer, I want to save and remove cards so that checkout is faster next time.',
        criteria: ['A customer can list, add and remove saved cards', 'Removing a card deletes its token at the payment provider'],
        priority: 'medium',
        status: 'ready',
      },
      {
        title: 'Currency conversion display',
        description: 'As an international customer, I want to see prices in my currency so that I know what I will pay.',
        criteria: ['Prices show in the customer’s currency with the exchange rate used', 'Rates refresh at least hourly'],
        priority: 'low',
        status: 'done',
        assignee: 'dev1@sdlc.local',
      },
    ],
  },
  {
    key: 'ONB',
    name: 'Customer Onboarding',
    description: 'Sign-up, identity verification and first-run experience.',
    members: [
      { email: 'lead@sdlc.local', role: 'owner' },
      { email: 'dev2@sdlc.local', role: 'developer' },
    ],
    storyAuthor: 'lead@sdlc.local',
    stories: [
      {
        title: 'Email sign-up with verification',
        description: 'As a new customer, I want to sign up with my email so that I can create an account.',
        criteria: ['A verification link is emailed and expires after 24 hours', 'An unverified account cannot place orders'],
        priority: 'high',
        status: 'ready',
      },
      {
        title: 'KYC document upload',
        description: 'As a new customer, I want to upload my ID document so that my account can be verified.',
        criteria: ['PDF, JPG and PNG up to 10 MB are accepted', 'Uploaded documents are encrypted at rest'],
        priority: 'medium',
        status: 'draft',
      },
    ],
  },
]

async function authUser(db: Db, email: string): Promise<AuthUser> {
  const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email.toLowerCase())).limit(1)
  if (!u) throw new Error(`Seed user ${email} missing`)
  return { id: u.id, orgId: u.orgId, email: u.email, displayName: u.displayName, orgRole: u.orgRole }
}

/** Walk a freshly created (draft/ready) story to its demo status through the real service calls. */
async function advanceStory(deps: ServiceDeps, lead: Caller, key: string, number: number, story: DemoStory): Promise<void> {
  if (story.status === 'draft' || story.status === 'ready') return
  const assignee = await authUser(deps.db, story.assignee!)
  await assignStory(deps, lead, key, number, { userId: assignee.id }) // ready → in_progress
  if (story.status === 'in_progress') return
  await transitionStory(deps, lead, key, number, { to: 'in_review' })
  if (story.status === 'in_review') return
  await transitionStory(deps, lead, key, number, { to: 'done' })
}

async function seedDemoProject(deps: ServiceDeps, admin: Caller, demo: DemoProject): Promise<boolean> {
  const [existing] = await deps.db.select({ id: projects.id }).from(projects).where(eq(projects.key, demo.key)).limit(1)
  if (existing) return false

  await createProject(deps, admin, { key: demo.key, name: demo.name, description: demo.description })
  for (const m of demo.members) {
    const u = await authUser(deps.db, m.email)
    await addMember(deps, admin, demo.key, { userId: u.id, role: m.role })
  }
  // The admin created the project (and so became its owner); hand it over to the real owner.
  await removeMember(deps, admin, demo.key, admin.user.id)

  const author: Caller = { user: await authUser(deps.db, demo.storyAuthor), via: 'seed' }
  for (const s of demo.stories) {
    const created = await createStory(deps, author, demo.key, {
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.criteria,
      priority: s.priority,
      status: s.status === 'draft' ? 'draft' : 'ready',
      labels: [],
    })
    await advanceStory(deps, author, demo.key, created.number, s)
  }
  return true
}

// ─── Main ────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig()
  const { db, pool } = createDb(config.DATABASE_URL)
  try {
    await db.insert(organizations).values({ name: 'Synergech', slug: 'synergech' }).onConflictDoNothing()
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, 'synergech')).limit(1)

    for (const u of SEED_USERS) {
      const [found] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(sql`lower(${users.email})`, u.email))
        .limit(1)
      if (!found) await db.insert(users).values({ ...u, orgId: org.id })
    }

    const replaced = await seedWorkflowTemplates(db)
    const quickFixAdded = await seedQuickFixTemplate(db)

    // `--templates`: only refresh the workflow templates and built-in agents (no demo projects or memory).
    if (process.argv.includes('--templates')) {
      const agentCount = await seedBuiltinAgents(db)
      console.log(`Refreshed 2 workflow templates (${STORY_DELIVERY_SPEC.name}, ${QUICK_FIX_SPEC.name}) and ${agentCount} built-in agents.`)
      return
    }

    const deps: ServiceDeps = { db, bus: new EventBus() }
    const admin: Caller = { user: await authUser(db, 'admin@sdlc.local'), via: 'seed' }
    const created: string[] = []
    for (const demo of DEMO_PROJECTS) {
      if (await seedDemoProject(deps, admin, demo)) created.push(demo.key)
    }
    // After the projects exist, so each one gets the built-ins enabled.
    const agentCount = await seedBuiltinAgents(db)
    const withMemory = await seedDemoMemory(deps, (email) => authUser(db, email))

    console.log(`Seeded: ${SEED_USERS.length} users, 2 workflow templates (${STORY_DELIVERY_SPEC.name}, ${QUICK_FIX_SPEC.name}); ${agentCount} built-in agents.`)
    if (replaced) console.log(`Replaced ${replaced} retired workflow${replaced === 1 ? '' : 's'} in existing projects with ${STORY_DELIVERY_SPEC.name}.`)
    if (quickFixAdded) console.log(`Added ${QUICK_FIX_SPEC.name} to ${quickFixAdded} existing project${quickFixAdded === 1 ? '' : 's'}.`)
    console.log(created.length ? `Demo projects created: ${created.join(', ')}.` : 'Demo projects already present — left as they are.')
    if (withMemory.length) console.log(`Demo memory added to: ${withMemory.join(', ')}.`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
