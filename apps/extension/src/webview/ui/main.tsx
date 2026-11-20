// Phase 5A — webview entry point. Mounts the React canvas and pulls in React Flow's stylesheet plus
// our VS Code-themed overrides. esbuild bundles the imported CSS into dist/webview/main.css, which the
// panel links with a CSP-allowed <link>. See workflowCanvasPanel.html.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles.css'
import { App } from './App'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
