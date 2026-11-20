// Context bridging the builder's node-delete handler down to the shared BaseNode renderer.
//
// Both view mode and builder mode render nodes through the same BaseNode (see nodes/index.tsx),
// and BaseNode only receives `data` from React Flow. This context lets BuilderShell expose an
// in-memory delete callback + an editable flag to the nodes without touching view mode: view mode
// simply has no provider, so `editable` defaults to false and no delete affordance is shown.

import { createContext } from 'react'

export interface BuilderNodeContextValue {
  editable: boolean
  onDeleteNode?: (id: string) => void
}

export const BuilderNodeContext = createContext<BuilderNodeContextValue>({ editable: false })
