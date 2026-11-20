// Demo memory for the seeded projects, so the memory screens show what the feature is for: project conventions
// and decisions a lead curated, notes a developer took on their story, and one promotion waiting for a lead.
// Written through the same services the API uses. Only runs for a project that has no memory yet.

import { eq, sql } from 'drizzle-orm'
import { CreateMemoryInputSchema, type CreateMemoryInput } from '@sdlc/contracts'
import type { AuthUser } from '../auth'
import type { Caller, ServiceDeps } from '../services/context'
import { addProjectMemory, addStoryMemory, promoteMemory } from '../services/memory'
import { memoryItems, projects } from './schema'

interface DemoMemory {
  key: string
  curator: string
  project: CreateMemoryInput[]
  stories: Array<{ number: number; author: string; items: CreateMemoryInput[]; promoteFirst?: boolean }>
}

const DEMO_MEMORY: DemoMemory[] = [
  {
    key: 'PAY',
    curator: 'lead@sdlc.local',
    project: [
      {
        kind: 'convention',
        pinned: true,
        title: 'Money is stored in minor units',
        content:
          'Store and compute every amount as an integer in the smallest currency unit (paise, cents). Never use floating point for money; convert to a decimal string only when displaying it.',
        tags: ['money'],
      },
      {
        kind: 'convention',
        pinned: true,
        title: 'Every read of payment data is audit-logged',
        content:
          'Call PaymentAudit.record(actor, purpose) before returning any card or payment data. PCI DSS requires who, when and why — reviews reject changes that skip it.',
        tags: ['pci', 'audit'],
        fileRefs: [{ path: 'src/payments/audit.ts' }],
      },
      {
        kind: 'decision',
        title: 'Card details are tokenised by the payment provider',
        content:
          'Checkout uses the provider’s hosted card fields, so our servers only ever see a token. Do not add endpoints that accept raw card numbers.',
        tags: ['pci', 'checkout'],
      },
      {
        kind: 'learning',
        title: 'Check refunds against the captured amount, not the authorised one',
        content: 'A partial capture followed by a full refund over-refunded in testing. Always compare with captured_amount − refunded_amount.',
        tags: ['refunds'],
      },
    ],
    stories: [
      {
        number: 2,
        author: 'dev1@sdlc.local',
        items: [
          {
            kind: 'note',
            title: 'Track refunded amount on the payment row',
            content: 'Keep a running refunded_amount on payments and reject a refund that would exceed captured_amount − refunded_amount.',
            fileRefs: [{ path: 'src/payments/refunds.ts', startLine: 12, endLine: 40 }],
          },
          {
            kind: 'decision',
            title: 'Refund requests are idempotent',
            content: 'Clients send an Idempotency-Key header; a retried refund returns the first result instead of refunding twice.',
          },
        ],
      },
      {
        number: 6,
        author: 'dev1@sdlc.local',
        promoteFirst: true,
        items: [
          {
            kind: 'decision',
            title: 'Exchange rates are cached for one hour',
            content: 'Rates come from the provider’s FX endpoint and are cached for 60 minutes; checkout shows the rate and the time it was fetched.',
            tags: ['fx'],
          },
        ],
      },
    ],
  },
  {
    key: 'ONB',
    curator: 'lead@sdlc.local',
    project: [
      {
        kind: 'convention',
        pinned: true,
        title: 'Verification links are signed and single-use',
        content: 'Sign verification tokens with the onboarding key, store only their hash, and mark them used on first click. Expired or reused links show a resend option.',
        tags: ['security'],
      },
    ],
    stories: [],
  },
]

/** Seed demo memory into projects that have none. Returns the keys of the projects it wrote to. */
export async function seedDemoMemory(deps: ServiceDeps, userByEmail: (email: string) => Promise<AuthUser>): Promise<string[]> {
  const seeded: string[] = []
  for (const demo of DEMO_MEMORY) {
    const [project] = await deps.db.select({ id: projects.id }).from(projects).where(eq(projects.key, demo.key)).limit(1)
    if (!project) continue
    const [{ count }] = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(memoryItems)
      .where(eq(memoryItems.projectId, project.id))
    if (count > 0) continue

    const curator: Caller = { user: await userByEmail(demo.curator), via: 'seed' }
    for (const item of demo.project) {
      await addProjectMemory(deps, curator, demo.key, CreateMemoryInputSchema.parse(item))
    }
    for (const story of demo.stories) {
      const author: Caller = { user: await userByEmail(story.author), via: 'seed' }
      for (const [i, item] of story.items.entries()) {
        const created = await addStoryMemory(deps, author, demo.key, story.number, CreateMemoryInputSchema.parse(item))
        // Leaves one developer promotion waiting in the lead's Proposals tab.
        if (story.promoteFirst && i === 0) await promoteMemory(deps, author, demo.key, created.id)
      }
    }
    seeded.push(demo.key)
  }
  return seeded
}
