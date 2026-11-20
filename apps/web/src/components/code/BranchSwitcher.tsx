'use client'

// Pick any branch on the remote. Branches nobody opened yet are loaded on first pick (a quick shallow fetch on the
// server); "Create branch" makes a new one from the current branch, straight on the remote.

import { useState, type FormEvent } from 'react'
import { Check, ChevronsUpDown, GitBranch, Laptop, Plus } from 'lucide-react'
import { CreateBranchInputSchema, type RepoBranch, type RunBranch } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

interface Props {
  branches: RepoBranch[]
  current: string
  canCreate: boolean
  onSelect: (branch: string) => void
  onCreate: (name: string, from: string) => Promise<void>
  /** Workflow runs' branches (local to the VS Code that ran them), listed below the remote's. */
  runBranches?: RunBranch[]
  onSelectRun?: (runId: string) => void
}

function CreateBranchDialog({ open, from, onOpenChange, onCreate }: { open: boolean; from: string; onOpenChange: (o: boolean) => void; onCreate: Props['onCreate'] }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const parsed = CreateBranchInputSchema.safeParse({ name, from })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Not a valid branch name.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCreate(parsed.data.name, parsed.data.from)
      setName('')
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not create the branch.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Create branch</DialogTitle>
            <DialogDescription>
              Creates the branch on the remote from the tip of <span className="font-mono">{from}</span>.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="new-branch-name">Branch name</FieldLabel>
            <Input id="new-branch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/my-change" className="font-mono" autoFocus />
            <FieldDescription>Letters, digits, - _ . and / — no spaces.</FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? <Spinner /> : <Plus />}
              Create branch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function BranchSwitcher({ branches, current, canCreate, onSelect, onCreate, runBranches = [], onSelectRun }: Props) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const active = branches.find((b) => b.name === current)

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" role="combobox" aria-expanded={open} className="max-w-72 justify-between gap-2 font-mono text-xs">
            <GitBranch className="text-muted-foreground" />
            <span className="truncate">{current}</span>
            {active?.indexing ? <Spinner className="size-3" /> : null}
            <ChevronsUpDown className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command>
            <CommandInput placeholder="Find a branch…" />
            <CommandList>
              <CommandEmpty>No branch matches.</CommandEmpty>
              <CommandGroup heading={`${branches.length} ${branches.length === 1 ? 'branch' : 'branches'}`}>
                {branches.map((b) => (
                  <CommandItem
                    key={b.name}
                    value={b.name}
                    onSelect={() => {
                      setOpen(false)
                      onSelect(b.name)
                    }}
                    className="gap-2"
                  >
                    <Check className={cn('size-4', b.name === current ? 'opacity-100' : 'opacity-0')} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{b.name}</span>
                    {b.myDraftCount > 0 ? (
                      <Badge variant="warning" className="h-4 px-1.5 text-[10px]" title="Your uncommitted edits">
                        {b.myDraftCount} edited
                      </Badge>
                    ) : null}
                    {b.isDefault ? (
                      <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                        default
                      </Badge>
                    ) : null}
                    {b.indexing ? (
                      <Spinner className="size-3" />
                    ) : !b.indexedSha ? (
                      <span className="text-[10px] text-muted-foreground" title="Its files load the first time it is opened">
                        not loaded
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
              {runBranches.length && onSelectRun ? (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Workflow runs · local in VS Code, not pushed">
                    {runBranches.map((r) => (
                      <CommandItem
                        key={r.runId}
                        value={`run ${r.branch} ${r.storyKey ?? ''} ${r.runId}`}
                        onSelect={() => {
                          setOpen(false)
                          onSelectRun(r.runId)
                        }}
                        className="gap-2"
                      >
                        <Laptop className="size-4 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={r.branch}>
                          {r.branch}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground" title={`${r.workflowName} · ${r.status}`}>
                          {r.files} file{r.files === 1 ? '' : 's'}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              ) : null}
              {canCreate ? (
                <>
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem
                      onSelect={() => {
                        setOpen(false)
                        setCreating(true)
                      }}
                      className="gap-2"
                    >
                      <Plus className="size-4" />
                      Create branch from <span className="truncate font-mono text-xs">{current}</span>
                    </CommandItem>
                  </CommandGroup>
                </>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <CreateBranchDialog open={creating} from={current} onOpenChange={setCreating} onCreate={onCreate} />
    </>
  )
}
