import { Suspense } from 'react'
import WorkflowEditorContainer from '@/components/catalog/workflow-editor/WorkflowEditorContainer'

export default function NewWorkflowPage() {
  return (
    <Suspense>
      <WorkflowEditorContainer />
    </Suspense>
  )
}
