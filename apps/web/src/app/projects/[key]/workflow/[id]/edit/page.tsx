import { Suspense } from 'react'
import WorkflowEditorContainer from '@/components/catalog/workflow-editor/WorkflowEditorContainer'

export default function EditWorkflowPage() {
  return (
    <Suspense>
      <WorkflowEditorContainer />
    </Suspense>
  )
}
