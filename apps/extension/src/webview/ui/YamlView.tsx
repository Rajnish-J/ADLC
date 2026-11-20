// YAML view — renders the current WorkflowSpec as a YAML declaration.

import type { JSX } from 'react'
import type { WorkflowSpec } from '../../runtime/spec'
import { specToYaml } from './builderUtils'

interface Props {
  spec: WorkflowSpec
}

export function YamlView({ spec }: Props): JSX.Element {
  const yaml = specToYaml(spec)

  return (
    <div className="view-yaml">
      <div className="view-yaml__header">
        <span>YAML Declaration</span>
        <button
          className="toolbar__btn toolbar__btn--sm"
          onClick={() => void navigator.clipboard.writeText(yaml)}
          title="Copy YAML"
        >
          Copy
        </button>
      </div>
      <pre className="view-yaml__code">{yaml}</pre>
    </div>
  )
}
