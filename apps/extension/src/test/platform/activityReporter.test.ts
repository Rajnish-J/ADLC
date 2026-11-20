// The run activity reporter never loops on a failing platform: a refused batch (4xx) is dropped so later events go
// through, other failures back off, and after the run is closed it gives up. Pure (no `vscode`): plain mocha.

import * as assert from 'assert'
import type { RunEventInput } from '@sdlc/contracts'
import { PlatformError } from '../../platform/platformClient'
import { ActivityReporter } from '../../platform/session/activityReporter'

class Memento {
  private readonly data = new Map<string, unknown>()
  keys(): readonly string[] {
    return [...this.data.keys()]
  }
  get<T>(key: string, fallback?: T): T {
    return (this.data.has(key) ? this.data.get(key) : fallback) as T
  }
  update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value)
    return Promise.resolve()
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RUN = '00000000-0000-4000-8000-000000000001'

suite('SDLC platform — activity reporter', function () {
  this.timeout(10_000)

  test('a batch the platform refuses is dropped and later events still go through', async () => {
    const sent: RunEventInput[][] = []
    let refuse = true
    const client = {
      reportRunEvents: async (_k: string, _r: string, input: { events: RunEventInput[] }) => {
        if (refuse) {
          refuse = false
          throw new PlatformError('Run is finished', 409)
        }
        sent.push(input.events)
        return { lastSeq: input.events.at(-1)!.seq }
      },
    }
    const r = new ActivityReporter('PAY', RUN, () => client, new Memento() as never, () => undefined, 5)
    r.add({ type: 'step.started', stepId: 's1' })
    await r.flush()
    r.add({ type: 'step.completed', stepId: 's1' })
    await r.flush()
    assert.deepStrictEqual(sent.flat().map((e) => e.type), ['step.completed'])
  })

  test('after close, an unreachable platform is retried a few times with backoff, then given up', async () => {
    let calls = 0
    const client = {
      reportRunEvents: async () => {
        calls++
        throw new PlatformError('unreachable')
      },
    }
    const r = new ActivityReporter('PAY', RUN, () => client, new Memento() as never, () => undefined, 2)
    r.add({ type: 'step.started', stepId: 's1' })
    await r.close()
    await wait(400)
    const settled = calls
    await wait(300)
    assert.ok(settled >= 2 && settled <= 4, `expected 2–4 attempts, got ${settled}`)
    assert.strictEqual(calls, settled, 'kept retrying after giving up')
  })
})
