import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { STORY_DELIVERY_SPEC } from '../storyDeliverySpec'
import { QUICK_FIX_SPEC } from '../quickFixSpec'
import { blankSpec } from '../specUtils'
import type { WorkflowSpec } from '../spec'
import { validateWorkflowSpec } from '../workflowDraft'
import {
  blankNode,
  builderFlowToSpec,
  canConnect,
  cleanNodeData,
  deletableNodeIds,
  ensureStartEnd,
  makeNodeId,
  nodeSubtitle,
  removeNodes,
  specToBuilderFlow,
  spliceEdges,
  type BuilderEdge,
  type BuilderNode,
} from './builderFlow'

function roundTrip(spec: WorkflowSpec): WorkflowSpec {
  const { nodes, edges } = specToBuilderFlow(spec)
  return builderFlowToSpec(nodes, edges, spec)
}

describe('specToBuilderFlow / builderFlowToSpec', () => {
  for (const [name, spec] of [
    ['story delivery', structuredClone(STORY_DELIVERY_SPEC)],
    ['quick fix', structuredClone(QUICK_FIX_SPEC)],
  ] as const) {
    it(`round-trips the ${name} workflow without losing nodes, data or edges`, () => {
      const back = roundTrip(spec)
      assert.equal(back.name, spec.name)
      assert.deepEqual(back.budget, spec.budget)
      assert.deepEqual(
        back.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, data: n.data })),
        spec.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, data: cleanNodeData(n.data) })),
      )
      assert.deepEqual(back.edges, spec.edges)
      // Specs without positions get laid out, and the laid-out positions are then saved.
      assert.ok(back.nodes.every((n) => n.position && Number.isInteger(n.position.x) && Number.isInteger(n.position.y)))
      assert.deepEqual(validateWorkflowSpec(back).errors, [])
    })
  }

  it('keeps saved positions and unknown data keys', () => {
    const spec = blankSpec('Positions')
    spec.nodes[0].position = { x: 10, y: 20 }
    spec.nodes[1].position = { x: 300.4, y: 20.6 }
    ;(spec.nodes[1].data as Record<string, unknown>).serverOnly = 'kept'
    const back = roundTrip(spec)
    assert.deepEqual(back.nodes[0].position, { x: 10, y: 20 })
    assert.deepEqual(back.nodes[1].position, { x: 300, y: 21 })
    assert.equal((back.nodes[1].data as Record<string, unknown>).serverOnly, 'kept')
  })

  it('applies the name/description overrides and drops empty values and dangling edges', () => {
    const spec = blankSpec('Old')
    const { nodes, edges } = specToBuilderFlow(spec)
    nodes[1].data.specData = { harness: '', skills: [], outputVar: undefined, question: 'ok?' }
    const back = builderFlowToSpec(nodes, [...edges, { source: 'trigger', target: 'missing' }, edges[0]], spec, {
      name: 'New',
      description: 'Desc',
    })
    assert.equal(back.name, 'New')
    assert.equal(back.description, 'Desc')
    assert.deepEqual(back.nodes[1].data, { question: 'ok?' })
    assert.deepEqual(back.edges, [{ source: 'trigger', target: 'end' }])
  })
})

describe('makeNodeId', () => {
  it('slugifies and never produces the reserved `__` or `:`', () => {
    assert.equal(makeNodeId('Set Variable', []), 'set-variable')
    assert.equal(makeNodeId('a__b::c', []), 'a-b-c')
    assert.equal(makeNodeId('!!!', []), 'step')
  })

  it('suffixes until the id is free', () => {
    assert.equal(makeNodeId('agent', ['agent', 'agent-2']), 'agent-3')
  })
})

describe('blankNode', () => {
  it('pre-fills a preset and picks a unique id', () => {
    const node = blankNode('agent', { x: 1, y: 2 }, ['implementer'], {
      idBase: 'implementer',
      label: 'Implementer',
      data: { agentId: 'implementer', agentName: 'Implementer' },
    })
    assert.equal(node.id, 'implementer-2')
    assert.equal(node.type, 'agent')
    assert.equal(node.data.label, 'Implementer')
    assert.equal(node.data.specData.agentId, 'implementer')
    assert.equal(nodeSubtitle({ kind: 'agent', data: node.data.specData }), 'Implementer')
  })
})

function flow(): { nodes: BuilderNode[]; edges: BuilderEdge[] } {
  return specToBuilderFlow(structuredClone(QUICK_FIX_SPEC))
}

describe('canConnect', () => {
  const { nodes, edges } = flow()
  const trigger = nodes.find((n) => n.data.kind === 'trigger')!.id
  const end = nodes.find((n) => n.data.kind === 'end')!.id
  const agent = nodes.find((n) => n.data.kind === 'agent')!.id

  it('rejects self-loops, edges into the start, out of an end and duplicates', () => {
    assert.match(canConnect(nodes, edges, { source: agent, target: agent })!, /itself/)
    assert.match(canConnect(nodes, edges, { source: agent, target: trigger })!, /start/)
    assert.match(canConnect(nodes, edges, { source: end, target: agent })!, /end step/)
    const existing = edges[0]
    assert.match(canConnect(nodes, edges, { source: existing.source, target: existing.target })!, /already/)
  })

  it('allows branching and loops back to earlier steps', () => {
    assert.equal(canConnect(nodes, edges, { source: trigger, target: end }), null)
    const later = nodes.filter((n) => n.data.kind === 'agent')[1].id
    assert.equal(canConnect(nodes, edges, { source: later, target: agent }), null)
  })
})

describe('deletableNodeIds', () => {
  it('never deletes the trigger or the last end', () => {
    const { nodes } = flow()
    const all = nodes.map((n) => n.id)
    const allowed = deletableNodeIds(nodes, all)
    assert.ok(!allowed.includes(nodes.find((n) => n.data.kind === 'trigger')!.id))
    assert.ok(!allowed.includes(nodes.find((n) => n.data.kind === 'end')!.id))
    assert.equal(allowed.length, nodes.length - 2)
  })

  it('lets one of two ends go', () => {
    const { nodes } = flow()
    const extra = blankNode('end', { x: 0, y: 0 }, nodes.map((n) => n.id))
    const both = [...nodes, extra]
    const ends = both.filter((n) => n.data.kind === 'end').map((n) => n.id)
    assert.equal(deletableNodeIds(both, ends).length, 1)
    assert.deepEqual(deletableNodeIds(both, [extra.id]), [extra.id])
  })
})

describe('ensureStartEnd', () => {
  it('adds a trigger wired to roots and an end wired from leaves', () => {
    const lone = blankNode('agent', { x: 0, y: 0 }, [])
    const { nodes, edges } = ensureStartEnd([lone], [])
    assert.deepEqual(
      nodes.map((n) => n.data.kind),
      ['trigger', 'agent', 'end'],
    )
    assert.deepEqual(
      edges.map((e) => [e.source, e.target]),
      [
        ['trigger', lone.id],
        [lone.id, 'end'],
      ],
    )
  })
})

describe('spliceEdges / removeNodes', () => {
  it('inserts a node after or before an anchor', () => {
    const { edges } = specToBuilderFlow(blankSpec('x'))
    const after = spliceEdges(edges, 'trigger', 'mid', 'after')
    assert.deepEqual(
      after.map((e) => [e.source, e.target]),
      [
        ['trigger', 'mid'],
        ['mid', 'end'],
      ],
    )
    const before = spliceEdges(edges, 'end', 'mid', 'before')
    assert.deepEqual(
      before.map((e) => [e.source, e.target]),
      [
        ['trigger', 'mid'],
        ['mid', 'end'],
      ],
    )
  })

  it('removes edges touching removed nodes and clears goto targets pointing at them', () => {
    const { nodes, edges } = flow()
    const agent = nodes.find((n) => n.data.kind === 'agent')!
    const goto = blankNode('goto', { x: 0, y: 0 }, nodes.map((n) => n.id), { data: { targetId: agent.id } })
    const out = removeNodes([...nodes, goto], edges, [agent.id])
    assert.ok(!out.nodes.some((n) => n.id === agent.id))
    assert.ok(!out.edges.some((e) => e.source === agent.id || e.target === agent.id))
    assert.equal(out.nodes.find((n) => n.id === goto.id)!.data.specData.targetId, undefined)
  })
})
