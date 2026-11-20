// Code view — renders Python / TypeScript sample invocation code.

import type { JSX } from 'react'
import { useState } from 'react'
import type { WorkflowSpec } from '../../runtime/spec'
import { specToPython, specToTypeScript } from './builderUtils'

interface Props {
  spec: WorkflowSpec
}

export function CodeView({ spec }: Props): JSX.Element {
  const [lang, setLang] = useState<'python' | 'typescript'>('python')
  const code = lang === 'python' ? specToPython(spec) : specToTypeScript(spec)

  return (
    <div className="view-code">
      <div className="view-code__header">
        <div className="toolbar__tabs">
          <button
            className={`toolbar__tab ${lang === 'python' ? 'toolbar__tab--active' : ''}`}
            onClick={() => setLang('python')}
          >
            Python
          </button>
          <button
            className={`toolbar__tab ${lang === 'typescript' ? 'toolbar__tab--active' : ''}`}
            onClick={() => setLang('typescript')}
          >
            TypeScript
          </button>
        </div>
        <button
          className="toolbar__btn toolbar__btn--sm"
          onClick={() => void navigator.clipboard.writeText(code)}
          title="Copy code"
        >
          Copy
        </button>
      </div>

      <div className="view-code__env">
        <strong>Required env vars:</strong>{' '}
        AZURE_AI_PROJECT_ENDPOINT, AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
      </div>

      <pre className="view-code__pre">{code}</pre>
    </div>
  )
}
