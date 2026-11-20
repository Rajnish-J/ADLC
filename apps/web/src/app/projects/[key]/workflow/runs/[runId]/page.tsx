import { Suspense } from 'react'
import RunDetailContainer from '@/components/runs/RunDetailContainer'

export default function RunPage() {
  return (
    <Suspense>
      <RunDetailContainer />
    </Suspense>
  )
}
