import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChangedFile, TreeEntry } from '@sdlc/contracts'
import { overlayTree, patchSection } from './runBranches'

const file = (path: string): TreeEntry => ({ path, name: path.split('/').pop() ?? path, type: 'file', size: 1, status: 'stored', hasDraft: false })
const dir = (path: string): TreeEntry => ({ path, name: path.split('/').pop() ?? path, type: 'dir', size: 0, status: null, hasDraft: false })
const changed = (path: string, status: ChangedFile['status'], oldPath?: string): ChangedFile => ({
  path,
  status,
  additions: 1,
  deletions: 0,
  binary: false,
  excluded: false,
  ...(oldPath ? { oldPath } : {}),
})

describe('overlayTree', () => {
  const files = [
    changed('src/app.ts', 'modified'),
    changed('src/new/feature.ts', 'untracked'),
    changed('README.md', 'deleted'),
    changed('docs/guide.md', 'renamed', 'docs/old.md'),
  ]

  it('marks root entries and counts changes inside folders', () => {
    const root = overlayTree([dir('src'), dir('docs'), file('README.md'), file('package.json')], files, '')
    const by = new Map(root.map((e) => [e.path, e]))
    assert.equal(by.get('README.md')?.change, 'deleted')
    assert.equal(by.get('package.json')?.change, null)
    assert.equal(by.get('src')?.changeCount, 2)
    assert.equal(by.get('src')?.change, 'modified')
    // docs/guide.md (renamed) + docs/old.md (its old path, deleted)
    assert.equal(by.get('docs')?.changeCount, 2)
    assert.deepEqual(
      root.map((e) => e.path),
      ['docs', 'src', 'package.json', 'README.md'],
    )
  })

  it('injects added files and folders the base branch does not have', () => {
    const src = overlayTree([file('src/app.ts')], files, 'src')
    assert.deepEqual(
      src.map((e) => [e.path, e.type, e.change]),
      [
        ['src/new', 'dir', 'added'],
        ['src/app.ts', 'file', 'modified'],
      ],
    )
    const added = overlayTree([], files, 'src/new')
    assert.deepEqual(added.map((e) => [e.path, e.change]), [['src/new/feature.ts', 'added']])
  })

  it('shows a rename at its new path and the old path as deleted', () => {
    const docs = overlayTree([file('docs/old.md')], files, 'docs')
    assert.deepEqual(
      docs.map((e) => [e.path, e.change]),
      [
        ['docs/guide.md', 'renamed'],
        ['docs/old.md', 'deleted'],
      ],
    )
  })
})

describe('patchSection', () => {
  const patch = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-x', '+y', 'diff --git a/b.ts b/b.ts', '+z', ''].join('\n')

  it('returns one file’s section of the combined patch', () => {
    assert.equal(patchSection(patch, 'a.ts'), ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-x', '+y'].join('\n'))
    assert.equal(patchSection(patch, 'b.ts'), ['diff --git a/b.ts b/b.ts', '+z'].join('\n'))
    assert.equal(patchSection(patch, 'c.ts'), null)
    assert.equal(patchSection(null, 'a.ts'), null)
  })
})
