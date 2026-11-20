// Unit tests for the pure parts of the project profile: the counted (no-AI) profile, the update input, the
// changelog, the compact context agents get and how it is merged with memory. Run with `npm test -w @sdlc/api`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ProfileContentSchema, renderProfileMarkdown, type ProfileContent } from '@sdlc/contracts'
import { collectProfileEvidence, profileFilesToRead } from '@sdlc/core'
import { formatMemoryContext, readIds, withProfile } from './memoryContext'
import { alreadyFolded } from './projectProfile'
import {
  clampSections,
  deterministicProfile,
  inputHash,
  mergeChangelog,
  profileContextMarkdown,
  readmeIntro,
  renderFacts,
  renderRunsForUpdate,
  stackOf,
  type PlatformFacts,
} from './profileContent'

const REPO: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', description: 'An online shop for hand-made furniture.', scripts: { dev: 'next dev', test: 'vitest', build: 'next build' }, dependencies: { next: '15', react: '19' }, devDependencies: { vitest: '2' } }),
  'README.md': '# Shop\n\n[![ci](badge.svg)](x)\n\nShop lets makers sell furniture online.\n\nIt handles carts and payments.\n\n## Setup\nnpm i',
  '.env.example': 'STRIPE_KEY=sk_live_123\nDATABASE_URL=postgres://u:p@h/db',
  '.github/workflows/ci.yml': 'on: push',
  'src/app/page.tsx': '',
  'src/lib/cart.ts': '',
  'src/lib/cart.test.ts': '',
}

const facts: PlatformFacts = {
  projectName: 'Shop',
  projectKey: 'SHOP',
  description: '',
  branch: 'main',
  commit: { sha: 'abcdef1234', message: 'Add cart', author: 'Asha', at: '2026-11-18T10:00:00.000Z' },
  stories: { done: 3, in_progress: 1 },
  recentRuns: [{ workflow: 'Story delivery', status: 'completed', story: 'SHOP-4 Cart', finishedAt: '2026-11-18T10:00:00.000Z' }],
  successRate: 100,
}

function evidence() {
  const paths = Object.keys(REPO)
  return collectProfileEvidence(paths, new Map(profileFilesToRead(paths).map((p) => [p, REPO[p]])))
}

function content(): ProfileContent {
  const e = evidence()
  return { ...deterministicProfile(e, facts), stack: stackOf(e), changelog: [] }
}

describe('counted profile (no AI model)', () => {
  it('fills every section from the repository and platform facts', () => {
    const c = content()
    assert.equal(c.headline, 'An online shop for hand-made furniture.')
    assert.equal(c.maturity, 'active')
    assert.match(c.sections.overview.markdown, /Shop lets makers sell furniture online\./)
    assert.match(c.sections.techStack.markdown, /Next\.js, React, Vitest/)
    assert.match(c.sections.developerGuide.markdown, /`npm run dev` — next dev/)
    assert.match(c.sections.developerGuide.markdown, /`STRIPE_KEY`, `DATABASE_URL`/)
    assert.ok(!JSON.stringify(c).includes('sk_live_123'), 'secret values never reach the profile')
    assert.match(c.sections.status.markdown, /done 3, in progress 1/)
    assert.match(c.sections.integrations.markdown, /\.github\/workflows\/ci\.yml/)
    assert.ok(ProfileContentSchema.safeParse(c).success)
  })

  it('takes the README intro without headings or badges', () => {
    assert.equal(readmeIntro(REPO['README.md']), 'Shop lets makers sell furniture online.\n\nIt handles carts and payments.')
  })
})

describe('rendering', () => {
  it('renders the whole profile as one Markdown document', () => {
    const md = renderProfileMarkdown('Shop', { ...content(), changelog: [{ at: '2026-11-19T00:00:00.000Z', runId: null, summary: 'Generated from main' }] }, { branch: 'main', version: 2 })
    for (const heading of ['# Shop — project profile', '## Overview', '## Tech stack', '## Architecture', '## Status & delivery health', '## Developer guide', '## Integrations, CI/CD & risks', '## Recent changes']) {
      assert.ok(md.includes(heading), heading)
    }
    assert.match(md, /Branch: main · Version: 2/)
  })

  it('platform facts name stories, runs and the last commit', () => {
    const text = renderFacts(facts)
    assert.match(text, /Stories by status: done 3, in_progress 1/)
    assert.match(text, /success rate 100%/)
    assert.match(text, /Last commit: "Add cart" by Asha on 2026-11-18/)
  })

  it('the update input lists each run with impact, files and a clipped patch', () => {
    const text = renderRunsForUpdate([
      { id: 'r1', workflowName: 'Quick fix', story: null, prompt: 'Add Stripe webhooks', finishedAt: '2026-11-19T09:00:00.000Z', branch: 'fix/hooks', files: [{ path: 'src/api/webhooks.ts', status: 'added', additions: 40, deletions: 0 }], changedFiles: [], patch: 'x'.repeat(5_000), summary: 'Added a webhook route.' },
    ], 2_000)
    assert.match(text, /### Run r1/)
    assert.match(text, /Work item: Quick fix \(no story\)/)
    assert.match(text, /- src\/api\/webhooks\.ts \[added\] \+40 −0/)
    assert.ok(text.length < 3_000)
  })

  it('the hash changes with the input', () => {
    assert.equal(inputHash('a'), inputHash('a'))
    assert.notEqual(inputHash('a'), inputHash('b'))
  })
})

describe('changelog and clamping', () => {
  it('puts new changes first, drops duplicates and caps the list', () => {
    const old = [{ at: '1', runId: 'a', summary: 'one' }]
    const merged = mergeChangelog(old, [{ at: '2', runId: 'b', summary: 'two' }, { at: '1', runId: 'a', summary: 'one' }], 2)
    assert.deepEqual(merged.map((c) => c.runId), ['b', 'a'])
    assert.equal(mergeChangelog([], Array.from({ length: 40 }, (_, i) => ({ at: '', runId: null, summary: String(i) }))).length, 30)
  })

  it('clamps model output: trims, dedupes and caps sources', () => {
    const s = { markdown: '  body  ', sources: Array.from({ length: 15 }, (_, i) => `f${i % 12}.ts`) }
    const out = clampSections({ overview: s, techStack: s, architecture: s, status: s, developerGuide: s, integrations: s })
    assert.equal(out.overview.markdown, 'body')
    assert.equal(out.overview.sources.length, 10)
  })
})

describe('agent context', () => {
  it('is compact and leads with the headline and stack', () => {
    const md = profileContextMarkdown(content(), 2_000)
    assert.ok(md.startsWith('**An online shop for hand-made furniture.** (maturity: active)'))
    assert.match(md, /Stack: TypeScript, Next\.js, React/)
    assert.ok(md.length <= 2_001)
  })

  it('goes before the memory items, which get the rest of the budget', () => {
    const items = [{ id: 'm1', kind: 'convention' as const, title: 'Use UTC', content: 'Always.', fileRefs: [] }]
    const ctx = withProfile('the SHOP project', 'PROFILE BODY', (budget) => formatMemoryContext('the SHOP project', [{ heading: 'Conventions', items }], budget), 12_000)
    const lines = ctx.markdown.split('\n')
    assert.match(lines[0], /^Knowledge recorded on the SDLC platform for the SHOP project/)
    assert.equal(lines[2], '### Project profile')
    assert.ok(ctx.markdown.indexOf('PROFILE BODY') < ctx.markdown.indexOf('Use UTC'))
    assert.deepEqual(ctx.itemIds, ['m1'])
  })

  it('stands alone when there are no memory items, and adds nothing without a profile', () => {
    const empty = (budget: number) => formatMemoryContext('x', [], budget)
    assert.match(withProfile('x', 'PROFILE', empty, 12_000).markdown, /### Project profile\nPROFILE$/)
    assert.deepEqual(withProfile('x', '', empty, 12_000), { markdown: '', itemIds: [] })
  })

  it('records the profile’s memory item as read when the profile was given', () => {
    assert.deepEqual(readIds({ markdown: 'ctx', itemIds: ['m1'] }, 'p1'), ['m1', 'p1'])
    assert.deepEqual(readIds({ markdown: 'ctx', itemIds: ['m1', 'p1'] }, 'p1'), ['m1', 'p1'])
    assert.deepEqual(readIds({ markdown: 'ctx', itemIds: ['m1'] }, null), ['m1'])
    assert.deepEqual(readIds({ markdown: '', itemIds: [] }, 'p1'), [])
  })
})

describe('runs folded into a profile', () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 10, 19, 10, minutes))
  const folded = [
    { runIds: ['a', 'b'], at: t(10) },
    { runIds: ['b'], at: t(30) },
  ]

  it('a folded run is not folded again', () => {
    assert.deepEqual([...alreadyFolded(folded, new Map())].sort(), ['a', 'b'])
    // Its changes were reported before the (last) fold: the fold saw them.
    const before = new Map([['b', { at: t(20), finishedAt: t(5) }]])
    assert.ok(alreadyFolded(folded, before).has('b'))
  })

  it('a run whose final change report arrived after the fold is folded again', () => {
    const late = new Map([['a', { at: t(20), finishedAt: t(5) }]])
    const seen = alreadyFolded(folded, late)
    assert.ok(!seen.has('a'))
    assert.ok(seen.has('b'))
  })

  it('a report long after the run finished does not re-fold it', () => {
    const much = new Map([['a', { at: new Date(t(5).getTime() + 2 * 24 * 60 * 60 * 1_000), finishedAt: t(5) }]])
    assert.ok(alreadyFolded(folded, much).has('a'))
  })
})
