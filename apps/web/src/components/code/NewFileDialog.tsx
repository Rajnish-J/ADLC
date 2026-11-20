'use client'

// Add a file to a workspace: a path (folders are created as needed), committed at once and opened for editing.

import { useEffect, useState, type FormEvent } from 'react'
import { FilePlus } from 'lucide-react'
import { RepoPathSchema } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Folder to start the path in ('' = the root). */
  folder: string
  onCreate: (path: string) => Promise<void>
}

export default function NewFileDialog({ open, onOpenChange, folder, onCreate }: Props) {
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setPath(folder ? `${folder}/` : '')
      setError(null)
    }
  }, [open, folder])

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const parsed = RepoPathSchema.safeParse(path.trim().replace(/^\/+/, ''))
    if (!parsed.success) {
      setError('Use a relative path like src/index.ts — no leading slash, no "..".')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCreate(parsed.data)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not create the file.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>New file</DialogTitle>
            <DialogDescription>Adds an empty file to the workspace and opens it for editing.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="new-file-path">Path</FieldLabel>
            <Input id="new-file-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="src/index.ts" className="font-mono" autoFocus />
            <FieldDescription>Folders in the path are created for you.</FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !path.trim() || path.trim().endsWith('/')}>
              {saving ? <Spinner /> : <FilePlus />} Create file
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
