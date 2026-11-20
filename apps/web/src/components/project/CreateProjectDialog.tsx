'use client'

// New project (org admins): start a blank workspace (just a name) or import a repository one of the
// organisation's access tokens can reach (the project takes its name). Either way the creator becomes the owner,
// the project gets the workflow templates and the whole agent catalog, and the Code page opens.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { AccessibleRepo } from '@sdlc/contracts'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useSession } from '@/components/providers/SessionProvider'
import { createProject } from '@/service/project.service'
import BlankView from './new-project/BlankView'
import ChooseView from './new-project/ChooseView'
import ImportView from './new-project/ImportView'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type View = 'choose' | 'blank' | 'import'

export default function CreateProjectDialog({ open, onOpenChange }: Props) {
  const router = useRouter()
  const { me } = useSession()
  const [view, setView] = useState<View>('choose')

  function close(): void {
    onOpenChange(false)
    setView('choose')
  }

  async function createBlank(name: string): Promise<void> {
    const project = await createProject({ name, workspace: true })
    toast.success(`Created ${project.key} · ${project.name}`, { description: 'Your workspace is ready.' })
    close()
    router.push(`/projects/${encodeURIComponent(project.key)}/code?path=README.md`)
  }

  async function importRepo(repo: AccessibleRepo): Promise<void> {
    const project = await createProject({
      name: repo.name,
      description: repo.description ?? '',
      repository: { url: repo.url, defaultBranch: repo.defaultBranch ?? undefined, connectionId: repo.connectionId },
    })
    toast.success(`Created ${project.key} · ${project.name}`, { description: 'Cloning the repository — its code, agents and skills appear as soon as it finishes.' })
    close()
    router.push(`/projects/${encodeURIComponent(project.key)}/code`)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setView('choose')
        onOpenChange(next)
      }}
    >
      <DialogContent className={view === 'import' ? 'sm:max-w-xl' : 'sm:max-w-lg'}>
        {view === 'choose' ? (
          <ChooseView onBlank={() => setView('blank')} onImport={() => setView('import')} onNavigate={close} />
        ) : view === 'blank' ? (
          <BlankView onBack={() => setView('choose')} onCreate={createBlank} />
        ) : (
          <ImportView onBack={() => setView('choose')} onImport={importRepo} canManageConnections={me?.user.orgRole === 'org_admin'} />
        )}
      </DialogContent>
    </Dialog>
  )
}
