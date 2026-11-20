// Notes a harness leaves in the run's memory outbox (`memory-out/*.md`) become memory items: kind and title from
// front matter, a `kind:` line or the `# heading`, else the file name. Pure (no `vscode`): runs under plain mocha.

import * as assert from 'assert'
import { memoryOutboxHint, parseMemoryNote } from '../../platform/session/memoryOutbox'

suite('SDLC platform — memory outbox', () => {
  test('a heading, a kind line and a body', () => {
    assert.deepStrictEqual(parseMemoryNote('# Use Zod at the edges\nkind: convention\n\nValidate every request body with Zod.\n', 'zod.md'), {
      kind: 'convention',
      title: 'Use Zod at the edges',
      content: 'Validate every request body with Zod.',
    })
  })

  test('front matter, CRLF and a BOM', () => {
    const note = parseMemoryNote('﻿---\r\nkind: decision\r\ntitle: "Refunds go through the ledger"\r\n---\r\nNever update balances directly.\r\n', 'x.md')
    assert.deepStrictEqual(note, { kind: 'decision', title: 'Refunds go through the ledger', content: 'Never update balances directly.' })
  })

  test('no heading: the file name is the title; an unknown kind is a note; empty notes are skipped', () => {
    assert.deepStrictEqual(parseMemoryNote('kind: gossip\nThe CI cache key includes the lockfile.', 'ci-cache_key.md'), {
      kind: 'note',
      title: 'ci cache key',
      content: 'The CI cache key includes the lockfile.',
    })
    assert.strictEqual(parseMemoryNote('# Only a title\n', 'a.md'), undefined)
    assert.strictEqual(parseMemoryNote('   \n', 'a.md'), undefined)
  })

  test('the hint names the outbox folder', () => {
    assert.ok(memoryOutboxHint('.sdlc/sessions/PAY-2').includes('.sdlc/sessions/PAY-2/memory-out/'))
  })
})
