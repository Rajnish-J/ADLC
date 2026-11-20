// Security guard (Phase 2 exit criterion 4): the discovery engine must PARSE
// manifests, never EXECUTE them. This statically asserts that no source file under
// src/discovery uses a code-execution primitive (child_process, eval, the Function
// constructor, or process spawning). RegExp.prototype.exec is fine and expected.
//
// Source is read from the repo's `src/` tree (not the compiled `out/`), found by
// walking up to the nearest package.json.

import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'

const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
  { label: 'child_process', re: /child_process/ },
  { label: 'eval(', re: /\beval\s*\(/ },
  { label: 'new Function(', re: /new\s+Function\s*\(/ },
  { label: 'spawn(', re: /\bspawn(Sync)?\s*\(/ },
  { label: 'execSync(', re: /\bexecSync\s*\(/ },
]

function repoRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir
    }
    dir = path.dirname(dir)
  }
  throw new Error('Could not locate repo root from ' + start)
}

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...tsFiles(full))
    } else if (entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

suite('Discovery — security: never executes discovered code', () => {
  test('no execution primitives anywhere under src/discovery', () => {
    const discoveryDir = path.join(repoRoot(__dirname), 'src', 'discovery')
    assert.ok(fs.existsSync(discoveryDir), 'src/discovery should exist')
    // The pure parsers moved to @sdlc/core/discovery (shared with the API) — guard them too.
    const coreDiscoveryDir = path.join(repoRoot(__dirname), '..', '..', 'packages', 'core', 'src', 'discovery')
    assert.ok(fs.existsSync(coreDiscoveryDir), 'packages/core/src/discovery should exist')

    const offenders: string[] = []
    for (const file of [...tsFiles(discoveryDir), ...tsFiles(coreDiscoveryDir)]) {
      const text = fs.readFileSync(file, 'utf-8')
      for (const { label, re } of FORBIDDEN) {
        if (re.test(text)) {
          offenders.push(`${path.basename(file)}: ${label}`)
        }
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'Discovery must never execute discovered code; found: ' + offenders.join('; '),
    )
  })
})
