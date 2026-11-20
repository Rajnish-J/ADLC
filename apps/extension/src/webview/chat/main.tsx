// Entry point of the Chat panel's webview bundle (dist/webview/chat.js + chat.css).

import { createRoot } from 'react-dom/client'
import ChatApp from './ChatApp'
import './chat.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<ChatApp />)
