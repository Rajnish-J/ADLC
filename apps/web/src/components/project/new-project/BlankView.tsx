'use client'

// Blank project: a name is all it takes. The platform makes an empty workspace (a README on main) and the key.

import { useState, type FormEvent } from 'react'
import { ArrowLeft } from 'lucide-react'
import { CreateProjectInputSchema, suggestProjectKey } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

interface Props {
  onBack: () => void
  onCreate: (name: string) => Promise<void>
}

export default function BlankView({ onBack, onCreate }: Props) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const key = suggestProjectKey(name)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const parsed = CreateProjectInputSchema.safeParse({ name, workspace: true })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a project name.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCreate(parsed.data.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project.')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-6">
      <DialogHeader>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon" className="-ml-2 size-8" onClick={onBack} disabled={saving} aria-label="Back">
            <ArrowLeft />
          </Button>
          <DialogTitle className="text-xl">Blank project</DialogTitle>
        </div>
        <DialogDescription>An empty workspace you can edit straight away. Publish it to GitHub whenever you like.</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="blank-project-name">Project name</FieldLabel>
        <Input id="blank-project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Payments Portal" maxLength={100} autoFocus disabled={saving} />
        <FieldDescription>{key ? `Story keys will look like ${key}-1, ${key}-2, …` : 'The project key is made from the name.'}</FieldDescription>
        {error ? <FieldError>{error}</FieldError> : null}
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onBack} disabled={saving}>
          Back
        </Button>
        <Button type="submit" disabled={saving || !name.trim()}>
          {saving ? <Spinner /> : null} Create project
        </Button>
      </DialogFooter>
    </form>
  )
}
