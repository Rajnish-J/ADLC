'use client'

import { useRouter } from 'next/navigation'
import * as UI from '@/imports/UI.imports'
import * as S from '@/imports/story.imports'

function NewStory({ project }: { project: S.ProjectDetail }) {
  const router = useRouter()
  if (!project.permissions.includes('story.create')) {
    return <UI.ErrorAlert title="Not allowed" message="Only leads, owners and admins can create stories in this project." />
  }
  return (
    <UI.Card className="max-w-2xl">
      <UI.CardHeader>
        <UI.CardTitle>New user story</UI.CardTitle>
        <UI.CardDescription>
          Each story is a sub-project: a developer picks it up and works through it with the project&apos;s agents.
        </UI.CardDescription>
      </UI.CardHeader>
      <UI.CardContent>
        <S.StoryForm
          project={project}
          onCancel={() => router.back()}
          onCreated={(story) => {
            UI.toast.success(`${story.key} created`)
            router.push(`/projects/${story.projectKey}/stories/${story.number}`)
          }}
        />
      </UI.CardContent>
    </UI.Card>
  )
}

export default function NewStoryContainer() {
  return <S.ProjectShell title="New story">{(project) => <NewStory project={project} />}</S.ProjectShell>
}
