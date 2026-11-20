// Pure-parser unit tests for the six discovery adapters.
//
// Adapters take (relPath, content) and return InternalAgent[] with no `vscode`
// dependency, so these run as plain logic inside the Mocha host. Fixtures are
// inline so there's no build-time fixture-copy step. Verifies correct attribution
// (Phase 2 exit criterion 1) and graceful handling of malformed input (criterion 2).

import * as assert from 'assert'
import { claudeAgentAdapter } from '../../discovery/adapters/claudeAgent'
import { claudeSkillAdapter } from '../../discovery/adapters/claudeSkill'
import { agentsMdAdapter } from '../../discovery/adapters/agentsMd'
import { agentYamlAdapter } from '../../discovery/adapters/agentYaml'
import { copilotAdapter } from '../../discovery/adapters/copilot'
import { cursorRulesAdapter } from '../../discovery/adapters/cursorRules'
import { copilotAgentAdapter } from '../../discovery/adapters/copilotAgent'

suite('Discovery — adapters', () => {
  test('claude-agent: frontmatter + body → valid agent with tools', () => {
    const content = [
      '---',
      'name: Code Reviewer',
      'description: Reviews pull requests',
      'tools: Read, Grep, Bash',
      'model: claude-sonnet-4-6',
      '---',
      '',
      'You are a meticulous code reviewer.',
    ].join('\n')

    const [agent] = claudeAgentAdapter.parse('.claude/agents/reviewer.md', content)
    assert.strictEqual(agent.sourceKind, 'claude-agent')
    assert.strictEqual(agent.name, 'Code Reviewer')
    assert.strictEqual(agent.description, 'Reviews pull requests')
    assert.deepStrictEqual(agent.tools, ['Read', 'Grep', 'Bash'])
    assert.strictEqual(agent.model, 'claude-sonnet-4-6')
    assert.match(agent.instructions, /meticulous code reviewer/)
    assert.strictEqual(agent.status, 'valid')
    assert.strictEqual(agent.sourcePath, '.claude/agents/reviewer.md')
  })

  test('claude-agent: array-form tools parse correctly (js-yaml)', () => {
    const content = ['---', 'name: A', 'description: d', 'tools:', '  - Read', '  - Edit', '---', 'body'].join('\n')
    const [agent] = claudeAgentAdapter.parse('.claude/agents/a.md', content)
    assert.deepStrictEqual(agent.tools, ['Read', 'Edit'])
  })

  test('claude-skill: allowed-tools advertising shell flags bundled scripts', () => {
    const content = ['---', 'name: Deployer', 'description: deploys', 'allowed-tools: Bash', '---', 'Run the deploy.'].join('\n')
    const [agent] = claudeSkillAdapter.parse('.claude/skills/deployer/SKILL.md', content)
    assert.strictEqual(agent.sourceKind, 'claude-skill')
    assert.strictEqual(agent.hasBundledScripts, true)
  })

  test('agents-md: no frontmatter, name from H1', () => {
    const content = '# Backend Agents\n\nFollow the repo conventions.'
    const [agent] = agentsMdAdapter.parse('AGENTS.md', content)
    assert.strictEqual(agent.sourceKind, 'agents-md')
    assert.strictEqual(agent.name, 'Backend Agents')
    assert.match(agent.instructions, /repo conventions/)
  })

  test('agent-yaml: whole-document parse with field aliases', () => {
    const content = ['name: planner', 'summary: plans work', 'system_prompt: You plan tasks.', 'allowed_tools: [Read, Write]'].join('\n')
    const [agent] = agentYamlAdapter.parse('agent.yaml', content)
    assert.strictEqual(agent.name, 'planner')
    assert.strictEqual(agent.description, 'plans work')
    assert.strictEqual(agent.instructions, 'You plan tasks.')
    assert.deepStrictEqual(agent.tools, ['Read', 'Write'])
    assert.strictEqual(agent.status, 'valid')
  })

  test('agent-yaml: malformed YAML → skipped, not thrown', () => {
    const content = 'name: : : oops\n  - bad: [unclosed'
    const agents = agentYamlAdapter.parse('agent.yaml', content)
    assert.strictEqual(agents.length, 1)
    assert.strictEqual(agents[0].status, 'skipped')
    assert.ok(agents[0].issues.length > 0)
  })

  test('copilot: single instruction agent', () => {
    const [agent] = copilotAdapter.parse('.github/copilot-instructions.md', 'Use TypeScript everywhere.')
    assert.strictEqual(agent.sourceKind, 'copilot-instructions')
    assert.match(agent.instructions, /TypeScript/)
    assert.strictEqual(agent.status, 'valid')
  })

  test('cursor-rules: frontmatter description + body', () => {
    const content = ['---', 'description: React rules', '---', 'Prefer function components.'].join('\n')
    const [agent] = cursorRulesAdapter.parse('.cursor/rules/react.mdc', content)
    assert.strictEqual(agent.sourceKind, 'cursor-rules')
    assert.strictEqual(agent.name, 'react')
    assert.strictEqual(agent.description, 'React rules')
  })

  test('missing name → needs-attention with an issue', () => {
    const [agent] = agentYamlAdapter.parse('agent.yaml', 'description: only')
    assert.strictEqual(agent.status, 'needs-attention')
    assert.ok(agent.issues.some((i) => /name/i.test(i)))
  })

  test('claude-agent: without a name, a flat file is named after the file, AGENT.md after its folder', () => {
    const body = ['---', 'description: d', '---', 'Do the review.'].join('\n')
    assert.strictEqual(claudeAgentAdapter.parse('.claude/agents/reviewer.md', body)[0].name, 'reviewer')
    assert.strictEqual(claudeAgentAdapter.parse('.claude/agents/qa-agent/test-planner/AGENT.md', body)[0].name, 'test-planner')
  })

  test('copilot-agent: .github/agents/*.agent.md, named after the file when the front matter has no name', () => {
    const content = ['---', 'description: Plans work', 'tools: [search, fetch]', 'model: gpt-5', '---', 'You plan.'].join('\n')
    const [agent] = copilotAgentAdapter.parse('.github/agents/planner.agent.md', content)
    assert.strictEqual(agent.sourceKind, 'copilot-agent')
    assert.strictEqual(agent.name, 'planner')
    assert.deepStrictEqual(agent.tools, ['search', 'fetch'])
    assert.strictEqual(agent.model, 'gpt-5')
    assert.strictEqual(agent.status, 'valid')
  })
})
