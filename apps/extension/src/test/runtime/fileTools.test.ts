// Unit tests for the pure parts of the LM file-editing tool support:
// path-escape safety, agent→tool gating, and tool-call summarization.

import * as assert from 'assert'
import * as path from 'path'
import { safeRelativePath } from '../../runtime/dispatch/fileTools'
import { mapAgentToolsToFileTools } from '../../runtime/dispatch/toolGating'
import { summarizeToolCall } from '../../runtime/dispatch/lmAgentDispatcher'

const ROOT = path.resolve(path.sep === '\\' ? 'C:\\repo' : '/repo')

suite('LM file tools — safeRelativePath', () => {
  test('accepts a normal nested path and normalizes to POSIX', () => {
    assert.strictEqual(safeRelativePath(ROOT, 'src/app.ts'), 'src/app.ts')
  })
  test('treats the root itself as "."', () => {
    assert.strictEqual(safeRelativePath(ROOT, '.'), '.')
  })
  test('rejects parent escapes', () => {
    assert.strictEqual(safeRelativePath(ROOT, '../secret'), null)
    assert.strictEqual(safeRelativePath(ROOT, 'src/../../secret'), null)
  })
  test('rejects absolute paths and drive letters', () => {
    assert.strictEqual(safeRelativePath(ROOT, '/etc/passwd'), null)
    assert.strictEqual(safeRelativePath(ROOT, 'D:\\windows'), null)
  })
  test('rejects empty / non-string', () => {
    assert.strictEqual(safeRelativePath(ROOT, ''), null)
  })
})

suite('LM file tools — mapAgentToolsToFileTools', () => {
  test('empty or undefined → all tools', () => {
    assert.strictEqual(mapAgentToolsToFileTools(undefined), 'all')
    assert.strictEqual(mapAgentToolsToFileTools([]), 'all')
  })
  test('canonical names pass through', () => {
    const r = mapAgentToolsToFileTools(['write_file', 'read_file'])
    assert.notStrictEqual(r, 'all')
    const set = r as Set<string>
    assert.ok(set.has('write_file') && set.has('read_file') && set.size === 2)
  })
  test('aliases map (case-insensitive)', () => {
    const set = mapAgentToolsToFileTools(['Edit', 'grep', 'LS']) as Set<string>
    assert.ok(set.has('replace_in_file'))
    assert.ok(set.has('search_text'))
    assert.ok(set.has('list_dir'))
    assert.strictEqual(set.size, 3)
  })
  test('read-only agent never gets write power', () => {
    const set = mapAgentToolsToFileTools(['read']) as Set<string>
    assert.ok(set.has('read_file'))
    assert.ok(!set.has('write_file'))
  })
  test('non-file tools yield an empty set (declared, none match)', () => {
    const set = mapAgentToolsToFileTools(['deploy', 'browser']) as Set<string>
    assert.strictEqual(set.size, 0)
  })
})

suite('LM file tools — summarizeToolCall', () => {
  test('prefers a path argument', () => {
    assert.strictEqual(summarizeToolCall({ name: 'write_file', input: { path: 'src/x.ts' } }), 'write_file(src/x.ts)')
  })
  test('falls back to a truncated query', () => {
    assert.strictEqual(summarizeToolCall({ name: 'search_text', input: { query: 'todo' } }), 'search_text("todo")')
  })
  test('bare name when no useful args', () => {
    assert.strictEqual(summarizeToolCall({ name: 'list_dir', input: {} }), 'list_dir')
  })
})
