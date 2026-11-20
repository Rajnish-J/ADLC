import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MEMORY_SETTINGS, mergeProjectSettings, readProjectSettings, UpdateProjectInputSchema } from '@sdlc/contracts'
import { projectMemoryStatus } from './memoryCapture'
import { formatMemoryContext } from './memoryContext'

describe('project settings', () => {
  it('fills memory defaults for projects stored before memory settings existed', () => {
    const s = readProjectSettings({ defaultEngine: 'claude-code', allowedEngines: ['claude-code'] })
    assert.equal(s.defaultEngine, 'claude-code')
    assert.deepEqual(s.memory, DEFAULT_MEMORY_SETTINGS)
  })

  it('keeps valid memory fields and defaults invalid ones', () => {
    const s = readProjectSettings({ memory: { captureRunSummaries: false, contextBudget: 5, quickFixMemory: 'accept' } })
    assert.equal(s.memory.captureRunSummaries, false)
    assert.equal(s.memory.quickFixMemory, 'accept')
    assert.equal(s.memory.contextBudget, DEFAULT_MEMORY_SETTINGS.contextBudget)
  })

  it('a harness change keeps memory settings, and a memory change keeps harnesses', () => {
    const stored = readProjectSettings({ allowedEngines: ['codex'], defaultEngine: 'codex', memory: { provideToRuns: false } })
    const harness = mergeProjectSettings(stored, { allowedEngines: [], defaultEngine: 'copilot' })
    assert.equal(harness.memory.provideToRuns, false)
    assert.deepEqual(harness.allowedEngines, [])
    const memory = mergeProjectSettings(stored, { memory: { captureLearnings: false } })
    assert.deepEqual(memory.allowedEngines, ['codex'])
    assert.equal(memory.memory.provideToRuns, false)
    assert.equal(memory.memory.captureLearnings, false)
  })

  it('accepts a partial settings update', () => {
    assert.ok(UpdateProjectInputSchema.safeParse({ settings: { memory: { contextBudget: 8000 } } }).success)
    assert.ok(!UpdateProjectInputSchema.safeParse({ settings: { memory: { contextBudget: 100 } } }).success)
  })
})

describe('project memory status', () => {
  const accept = { quickFixMemory: 'accept' as const }
  const propose = { quickFixMemory: 'propose' as const }
  it('a quick fix (run with no story) follows the quick-fix memory policy, whoever writes it', () => {
    assert.equal(projectMemoryStatus(false, { storyId: null }, accept), 'accepted')
    assert.equal(projectMemoryStatus(true, { storyId: null }, propose), 'proposed')
    assert.equal(projectMemoryStatus(false, { storyId: null }, propose), 'proposed')
  })
  it('a story run or a manual write keeps the curator rule', () => {
    assert.equal(projectMemoryStatus(true, { storyId: 's1' }, propose), 'accepted')
    assert.equal(projectMemoryStatus(false, { storyId: 's1' }, accept), 'proposed')
    assert.equal(projectMemoryStatus(true, null, propose), 'accepted')
    assert.equal(projectMemoryStatus(false, null, accept), 'proposed')
  })
})

describe('formatMemoryContext budget', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, kind: 'note' as const, title: `Item ${i}`, content: 'x'.repeat(400), fileRefs: [] }))
  it('gives fewer items with a smaller budget', () => {
    const small = formatMemoryContext('P', [{ heading: 'H', items }], 2_000)
    const large = formatMemoryContext('P', [{ heading: 'H', items }], 12_000)
    assert.ok(small.markdown.length <= 2_100)
    assert.ok(small.itemIds.length < large.itemIds.length)
  })
})
