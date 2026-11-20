// Agent prompt assembly — the fix that keeps the work item visible to every agent, not just the first.

import * as assert from 'assert'
import { assembleAgentPrompt } from '../../runtime/dispatch/prompt'

suite('assembleAgentPrompt', () => {
  test('includes the work item for a downstream agent even when the handoff differs', () => {
    const out = assembleAgentPrompt({
      instructions: 'You are the bug analyst.',
      workItem: '# Bug #42: Login fails',
      workItemId: 42,
      workItemUrl: 'https://dev.azure.com/o/p/_workitems/edit/42',
      prior: 'Triage result: severity high, route to backend.',
    })
    assert.match(out, /You are the bug analyst\./)
    assert.match(out, /## Work Item/)
    assert.match(out, /Work item: #42/)
    assert.match(out, /# Bug #42: Login fails/)
    assert.match(out, /## Prior step output/)
    assert.match(out, /Triage result: severity high/)
    assert.match(out, /do not ask the user for it/)
  })

  test('first agent: handoff equals the work item, so no duplicate Prior section', () => {
    const seed = '# User Story #7: Add login'
    const out = assembleAgentPrompt({ instructions: 'Triager.', workItem: seed, prior: seed })
    assert.match(out, /## Work Item/)
    assert.ok(!out.includes('## Prior step output'), 'should not duplicate the seed as a prior step')
  })

  test('no work item: falls back to instructions + prior only', () => {
    const out = assembleAgentPrompt({ instructions: 'Do the thing.', prior: 'context here' })
    assert.ok(!out.includes('## Work Item'))
    assert.ok(!out.includes('do not ask the user'))
    assert.match(out, /Do the thing\./)
    assert.match(out, /context here/)
  })

  test('planOnly appends a plan-only instruction and skips the "act now" framing', () => {
    const out = assembleAgentPrompt({
      instructions: 'Do the thing.',
      workItem: '# Story #1',
      prior: '# Story #1',
      planOnly: true,
    })
    assert.match(out, /produce a concise, numbered PLAN/i)
    assert.match(out, /do NOT perform any action/i)
  })

  test('approvedPlan is included on the execute turn instead of the generic action framing', () => {
    const out = assembleAgentPrompt({
      instructions: 'Do the thing.',
      workItem: '# Story #1',
      prior: '# Story #1',
      approvedPlan: '1. Read the story. 2. Write the code.',
    })
    assert.match(out, /## Approved plan/)
    assert.match(out, /Carry out this plan now/)
    assert.ok(!out.includes('do not ask the user for it'))
  })
})
