// Who may move a story between statuses (packages/contracts allowedTransitions). Run with `npm test -w @sdlc/api`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { allowedTransitions, canPickUp, type Actor } from '@sdlc/contracts'

const dev: Actor = { userId: 'dev', orgRole: 'member' }
const other: Actor = { userId: 'other', orgRole: 'member' }
const lead: Actor = { userId: 'lead', orgRole: 'member' }
const moves = (actor: Actor, role: 'developer' | 'lead', status: 'ready' | 'in_progress', assigneeId: string | null) =>
  allowedTransitions(actor, role, { status, assigneeId }).map((t) => t.to)

describe('story transitions', () => {
  it('the assignee starts a Ready story that is already theirs (synced from Azure Boards)', () => {
    assert.ok(moves(dev, 'developer', 'ready', 'dev').includes('in_progress'))
    assert.equal(canPickUp(dev, 'developer', { status: 'ready', assigneeId: 'dev' }), false)
  })

  it('someone else, or anyone on an unassigned story, cannot start it without picking it up', () => {
    assert.ok(!moves(other, 'developer', 'ready', 'dev').includes('in_progress'))
    assert.ok(!moves(dev, 'developer', 'ready', null).includes('in_progress'))
    assert.ok(!moves(lead, 'lead', 'ready', null).includes('in_progress'))
    assert.equal(canPickUp(dev, 'developer', { status: 'ready', assigneeId: null }), true)
  })

  it('a lead may start an assigned Ready story', () => {
    assert.ok(moves(lead, 'lead', 'ready', 'dev').includes('in_progress'))
  })
})
