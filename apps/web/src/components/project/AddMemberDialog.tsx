'use client'

// Add someone from the org directory with a role you're allowed to grant. The person picker is a searchable
// combobox (Command in a Popover).

import { useEffect, useState } from 'react'
import { Check, ChevronsUpDown, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { AddMemberInputSchema, PROJECT_ROLE_LABELS, type ProjectDetail, type ProjectRole, type User } from '@sdlc/contracts'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { UserAvatar } from '@/components/common/user-avatar'
import { AppError } from '@/appError'
import { cn } from '@/lib/utils'
import { addMember } from '@/service/project.service'
import { listUsers } from '@/service/session.service'

interface Props {
  project: ProjectDetail
  onChange: (project: ProjectDetail) => void
}

export default function AddMemberDialog({ project, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [users, setUsers] = useState<User[]>([])
  const [userId, setUserId] = useState<string | null>(null)
  const [role, setRole] = useState<ProjectRole>(project.assignableRoles.includes('developer') ? 'developer' : project.assignableRoles[0])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    listUsers()
      .then(setUsers)
      .catch((err) => setError(err instanceof AppError ? err.message : 'Could not load the directory.'))
  }, [open])

  const memberIds = new Set(project.members.map((m) => m.user.id))
  const candidates = users.filter((u) => !memberIds.has(u.id))
  const chosen = candidates.find((u) => u.id === userId)

  async function submit(): Promise<void> {
    const parsed = AddMemberInputSchema.safeParse({ userId, role })
    if (!parsed.success) {
      setError('Choose a person and a role.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      onChange(await addMember(project.key, parsed.data))
      toast.success(`${chosen?.displayName ?? 'Member'} added as ${PROJECT_ROLE_LABELS[role]}`)
      setOpen(false)
      setUserId(null)
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not add the member.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus /> Add member
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a member to {project.key}</DialogTitle>
          <DialogDescription>Pick someone from the organization and the role they'll have in this project.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>Person</FieldLabel>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" aria-expanded={pickerOpen} className="w-full justify-between font-normal">
                  {chosen ? (
                    <span className="flex items-center gap-2">
                      <UserAvatar name={chosen.displayName} className="size-5" />
                      {chosen.displayName}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Search people…</span>
                  )}
                  <ChevronsUpDown className="opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
                <Command>
                  <CommandInput placeholder="Name or email…" />
                  <CommandList>
                    <CommandEmpty>{users.length === 0 ? 'Loading…' : 'Nobody else to add.'}</CommandEmpty>
                    <CommandGroup>
                      {candidates.map((u) => (
                        <CommandItem
                          key={u.id}
                          value={`${u.displayName} ${u.email}`}
                          onSelect={() => {
                            setUserId(u.id)
                            setPickerOpen(false)
                          }}
                        >
                          <UserAvatar name={u.displayName} className="size-5" />
                          <span className="flex flex-col">
                            <span>{u.displayName}</span>
                            <span className="text-xs text-muted-foreground">{u.email}</span>
                          </span>
                          <Check className={cn('ml-auto', u.id === userId ? 'opacity-100' : 'opacity-0')} />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </Field>
          <Field>
            <FieldLabel>Role</FieldLabel>
            <Select value={role} onValueChange={(v) => setRole(v as ProjectRole)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {project.assignableRoles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {PROJECT_ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !userId}>
            {saving ? <Spinner /> : null}
            Add member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
