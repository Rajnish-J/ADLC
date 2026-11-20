// The built-in agents bundled with the extension (packages/core/agents) must cover every agent the default
// "Story delivery" workflow binds by slug, so the local default resolves real instructions offline.

import * as assert from 'assert'
import { STORY_DELIVERY_SPEC } from '@sdlc/core'
import { builtinAgentFile, listBuiltinAgents, lookupBuiltinAgent } from '../../runtime/builtinAgentRegistry'

suite('Built-in agents — bundled for the default workflow', () => {
  test('every agent step of Story delivery resolves to a built-in agent with instructions', () => {
    const slugs = STORY_DELIVERY_SPEC.nodes.flatMap((n) => (n.kind === 'agent' && n.data.agentId ? [n.data.agentId] : []))
    assert.ok(slugs.length >= 5)
    for (const slug of slugs) {
      const agent = lookupBuiltinAgent(slug)
      assert.ok(agent, `built-in agent "${slug}" is missing`)
      assert.strictEqual(agent.id, slug)
      assert.ok(agent.instructions.length > 100, `${slug} has no real instructions`)
    }
  })

  test('the parsed files carry the front matter the platform seeds from', () => {
    const planner = builtinAgentFile('planner')
    assert.strictEqual(planner?.name, 'Planner')
    assert.strictEqual(planner?.sourcePath, 'packages/core/agents/planner.md')
    assert.ok(listBuiltinAgents().some((a) => a.slug === 'pr-author'))
    assert.strictEqual(lookupBuiltinAgent('not-an-agent'), undefined)
  })
})
