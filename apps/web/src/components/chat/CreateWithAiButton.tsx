// "Create with AI": opens the Chat with the right specialist and this project already picked.

import Link from 'next/link'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function CreateWithAiButton({ agent, projectKey, label = 'Create with AI' }: { agent: string; projectKey: string; label?: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={`/chat?agent=${encodeURIComponent(agent)}&project=${encodeURIComponent(projectKey)}`}>
        <Sparkles className="size-3.5" />
        {label}
      </Link>
    </Button>
  )
}
