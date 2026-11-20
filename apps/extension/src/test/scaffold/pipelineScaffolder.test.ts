// Phase 3 — scaffolder renderer tests. These guard the exact YAML/JSON the ADO
// gate depends on (task name, inputs, threshold-trigger paths).

import * as assert from 'assert'
import {
  buildScaffoldDataset,
  renderDatasetJson,
  renderPipelineYaml,
  renderReadme,
} from '../../scaffold/pipelineScaffolder'

suite('Scaffold — ADO gate renderers', () => {
  test('dataset carries the step evaluators, thresholds, and judge deployment', () => {
    const ds = buildScaffoldDataset({ step: 'review', judgeDeployment: 'gpt-4o' })
    assert.ok(ds.evaluators.includes('builtin.task_adherence'))
    assert.strictEqual(ds.evaluator_parameters.deployment_name, 'gpt-4o')
    assert.deepStrictEqual(ds.evaluator_parameters['builtin.task_adherence'], { threshold: 3 })
    const json = renderDatasetJson(ds)
    assert.ok(json.trim().startsWith('{'))
    assert.ok(json.endsWith('\n'))
  })

  test('dataset omits data_mapping and emits query-only rows (task auto-maps + invokes agents)', () => {
    // The AIAgentEvaluation@2 task generates responses by invoking the agents and
    // auto-generates the field mapping. A hand-written data_mapping pointing at a
    // non-existent response/ground_truth column would break it — so it must be absent.
    const ds = buildScaffoldDataset({ step: 'review', judgeDeployment: 'gpt-4o' })
    assert.strictEqual(ds.data_mapping, undefined)
    assert.strictEqual(ds.dataMappings, undefined)
    for (const row of ds.data) {
      assert.deepStrictEqual(Object.keys(row), ['query'])
    }
    assert.strictEqual(renderDatasetJson(ds).includes('data_mapping'), false)
  })

  test('pipeline YAML uses the AIAgentEvaluation@2 task with the dataset path', () => {
    const yaml = renderPipelineYaml({ step: 'review', judgeDeployment: 'gpt-4o' })
    assert.ok(yaml.includes('AIAgentEvaluation@2'))
    assert.ok(yaml.includes('.sdlc/eval/dataset.json'))
    assert.ok(yaml.includes('group: sdlc-governance'))
  })

  test('pipeline triggers only on agent-manifest PRs (threshold-trigger, not every commit)', () => {
    const yaml = renderPipelineYaml({ step: 'review', judgeDeployment: 'gpt-4o' })
    assert.ok(yaml.includes('trigger: none'))
    assert.ok(yaml.includes('.claude/agents/**'))
    assert.ok(yaml.includes('SKILL.md'))
  })

  test('README calls out the required-build branch policy and AgentIds mapping', () => {
    const md = renderReadme({ step: 'review', judgeDeployment: 'gpt-4o' })
    assert.ok(md.includes('Required'))
    assert.ok(md.includes('AgentIds'))
    assert.ok(md.toLowerCase().includes('budget'))
  })
})
