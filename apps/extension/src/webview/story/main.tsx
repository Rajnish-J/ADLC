// Story panel webview entry: mounts the React app. esbuild bundles it (and story.css) into dist/webview/story.*.

import { createRoot } from 'react-dom/client'
import { StoryApp } from './StoryApp'
import './story.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<StoryApp />)
