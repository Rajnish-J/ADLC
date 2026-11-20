// LmAgentDispatcher per-run context: runs nobody bound (canvas / command runs) get the default context —
// so their agents receive instructions and gated tools instead of no instructions and every tool — and
// concurrently bound runs never see each other's agents or streams. Uses a fake vscode.lm model, so it
// needs the VS Code test host (vscode.LanguageModel* classes) but no Copilot.

import * as assert from 'assert'
import * as vscode from 'vscode'
import type { InternalAgent } from '../../discovery/agentModel'
import { LmAgentDispatcher, type DispatchContext } from '../../runtime/dispatch/lmAgentDispatcher'
import type { AgentDispatchInput } from '../../runtime/port'

interface Captured {
  prompt: string
  tools: string[]
}

/** A vscode.lm model double: records each request's prompt + offered tools and replies with fixed text. */
function fakeModel(reply: string, captured: Captured[]): vscode.LanguageModelChat {
  const model = {
    async sendRequest(messages: vscode.LanguageModelChatMessage[], options?: vscode.LanguageModelChatRequestOptions) {
      const first = messages[0]
      const prompt = first.content
        .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : ''))
        .join('')
      captured.push({ prompt, tools: (options?.tools ?? []).map((t) => t.name) })
      return {
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart(reply)
        })(),
        text: (async function* () {
          yield reply
        })(),
      }
    },
    async countTokens() {
      return 1
    },
  }
  return model as unknown as vscode.LanguageModelChat
}

function agent(name: string, tools: string[]): InternalAgent {
  return {
    id: `agent:${name}`,
    name,
    description: '',
    instructions: `You are ${name}.`,
    tools,
    sourceKind: 'claude-agent',
    sourcePath: `.claude/agents/${name}.md`,
    raw: '',
    status: 'valid',
    issues: [],
  }
}

function input(runId: string, agentName: string, phase: 'plan' | 'execute'): AgentDispatchInput {
  return { runId, nodeId: 'n1', stepId: `${runId}-n1-1`, agentId: `agent:${agentName}`, agentName, prompt: 'go', phase }
}

suite('LmAgentDispatcher per-run context', () => {
  test('an unbound run gets the default context: agent instructions and its declared tools', async () => {
    const captured: Captured[] = []
    const dispatcher = new LmAgentDispatcher()
    const implementer = agent('Implementer', ['read', 'edit'])
    let factoryCalls = 0
    dispatcher.setDefaultContext(async () => {
      factoryCalls += 1
      return { resolve: (id) => (id === implementer.id ? implementer : undefined), model: fakeModel('done', captured) }
    })

    await dispatcher.dispatch(input('canvas-run', 'Implementer', 'plan'))
    await dispatcher.dispatch(input('canvas-run', 'Implementer', 'execute'))

    assert.strictEqual(factoryCalls, 1, 'the default context is built once per run')
    assert.ok(captured[1].prompt.includes('You are Implementer.'), 'execute turn carries the agent instructions')
    assert.deepStrictEqual(captured[1].tools.sort(), ['read_file', 'replace_in_file'])
  })

  test('the planning turn is offered read-only tools only', async () => {
    const captured: Captured[] = []
    const dispatcher = new LmAgentDispatcher()
    const writer = agent('Writer', []) // declares nothing → every file tool when executing
    dispatcher.bindRun('r1', { resolve: () => writer, model: fakeModel('plan', captured) })

    await dispatcher.dispatch(input('r1', 'Writer', 'plan'))
    await dispatcher.dispatch(input('r1', 'Writer', 'execute'))

    assert.deepStrictEqual(captured[0].tools.sort(), ['list_dir', 'read_file', 'search_text'])
    assert.ok(captured[1].tools.includes('write_file'), 'execute turn may write')
  })

  test('an agent that cannot be resolved is offered read-only tools, not every tool', async () => {
    const captured: Captured[] = []
    const dispatcher = new LmAgentDispatcher()
    dispatcher.bindRun('r1', { resolve: () => undefined, model: fakeModel('x', captured) })
    await dispatcher.dispatch(input('r1', 'Ghost', 'execute'))
    assert.deepStrictEqual(captured[0].tools.sort(), ['list_dir', 'read_file', 'search_text'])
  })

  test('concurrently bound runs keep their own agents and fragment streams', async () => {
    const capturedA: Captured[] = []
    const capturedB: Captured[] = []
    const streamA: string[] = []
    const streamB: string[] = []
    const observed: Array<string | undefined> = []
    const dispatcher = new LmAgentDispatcher()
    const ctx = (name: string, captured: Captured[], stream: string[]): DispatchContext => ({
      resolve: () => agent(name, ['read']),
      model: fakeModel(`${name} says hi`, captured),
      onFragment: (_agent, fragment) => stream.push(fragment),
    })
    const a = dispatcher.bindRun('run-a', ctx('Alpha', capturedA, streamA))
    const b = dispatcher.bindRun('run-b', ctx('Beta', capturedB, streamB))
    const observer = dispatcher.observeFragments((_agent, _fragment, source) => observed.push(source.runId))

    await Promise.all([
      dispatcher.dispatch(input('run-a', 'Alpha', 'execute')),
      dispatcher.dispatch(input('run-b', 'Beta', 'execute')),
    ])

    assert.ok(capturedA[0].prompt.includes('You are Alpha.') && !capturedA[0].prompt.includes('Beta'))
    assert.ok(capturedB[0].prompt.includes('You are Beta.') && !capturedB[0].prompt.includes('Alpha'))
    assert.deepStrictEqual(streamA, ['Alpha says hi'])
    assert.deepStrictEqual(streamB, ['Beta says hi'])
    assert.deepStrictEqual(observed.sort(), ['run-a', 'run-b'])

    a.dispose()
    b.dispose()
    observer.dispose()
  })
})
