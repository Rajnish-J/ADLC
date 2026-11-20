import { Suspense } from 'react'
import ChatContainer from '@/components/chat/ChatContainer'

export default function ChatPage() {
  // The container reads ?thread / ?agent / ?project, which needs a Suspense boundary.
  return (
    <Suspense>
      <ChatContainer />
    </Suspense>
  )
}
