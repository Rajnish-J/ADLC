// Integration tests — run inside a real (headless) VS Code via @vscode/test-electron.
//
// These exercise the parts of Phase 1 that don't require interactive Azure login:
// the extension activates, its commands register, its views are contributed, and a
// no-auth command runs without throwing. Sign-in / Foundry-list (T2/T4) need an
// interactive Microsoft account and are verified manually (see README).

import * as assert from 'assert'
import * as vscode from 'vscode'

const EXTENSION_ID = 'synergech.sdlc-governance-extension'

const EXPECTED_COMMANDS = [
  'sdlcGovernance.helloWorld',
  'sdlcGovernance.signIn',
  'sdlcGovernance.signOut',
  'sdlcGovernance.refreshFoundryProjects',
  'sdlcGovernance.discover',
  'sdlcGovernance.clearConnection',
  // Phase 3
  'sdlcGovernance.governAndEvaluate',
  'sdlcGovernance.scaffoldAdoGate',
  'sdlcGovernance.openEvaluationResults',
]

suite('SDLC Governance — Phase 1 activation', () => {
  test('extension is present', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    assert.ok(ext, `Extension ${EXTENSION_ID} should be installed in the test host`)
  })

  test('extension activates', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    assert.ok(ext)
    await ext.activate()
    assert.strictEqual(ext.isActive, true, 'Extension should be active after activate()')
  })

  test('all commands are registered', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    await ext?.activate()
    const commands = await vscode.commands.getCommands(true)
    for (const id of EXPECTED_COMMANDS) {
      assert.ok(commands.includes(id), `Command "${id}" should be registered`)
    }
  })

  test('view container and views are contributed', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    assert.ok(ext)
    const contributes = ext.packageJSON.contributes as {
      viewsContainers?: { activitybar?: Array<{ id: string }> }
      views?: Record<string, Array<{ id: string }>>
    }
    const container = contributes.viewsContainers?.activitybar?.find((c) => c.id === 'sdlcGovernance')
    assert.ok(container, 'Activity-bar view container "sdlcGovernance" should be contributed')

    const views = contributes.views?.sdlcGovernance ?? []
    const viewIds = views.map((v) => v.id)
    // Three views; the former Overview / Discovered Agents / Foundry / Evaluation Results / Runs / Compliance
    // views are sections inside Agents and Workflows.
    assert.deepStrictEqual(viewIds, ['sdlcGovernance.platformStories', 'sdlcGovernance.agents', 'sdlcGovernance.workflows'])
  })

  test('Discover command runs without throwing (empty/no workspace is fine)', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    await ext?.activate()
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand('sdlcGovernance.discover')),
    )
  })

  test('Show Status command runs without throwing (no auth required)', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    await ext?.activate()
    // Should resolve cleanly even when signed out (reports "none").
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand('sdlcGovernance.helloWorld')),
    )
    // The command leaves its action menu open; close it so later tests start clean.
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
  })

  test('Refresh Foundry Projects command runs without throwing', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    await ext?.activate()
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand('sdlcGovernance.refreshFoundryProjects')),
    )
  })

  test('Open Evaluation Results command runs without throwing (no runs yet)', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    await ext?.activate()
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand('sdlcGovernance.openEvaluationResults')),
    )
  })
})
