'use client'

// Ctrl/Cmd+P: fuzzy-find any file on the branch, like VS Code's quick open. Paths load when it first opens.

import { useEffect, useState } from 'react'
import { FileCode2, Search } from 'lucide-react'
import type { RepoPaths } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { Button } from '@/components/ui/button'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Spinner } from '@/components/ui/spinner'
import { listPaths } from '@/service/code.service'

interface Props {
  projectKey: string
  branch: string
  onOpen: (path: string) => void
}

/** Show at most this many matches; cmdk filters the full list. */
const VISIBLE = 200

export default function QuickOpen({ projectKey, branch, onOpen }: Props) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{ branch: string; paths: RepoPaths } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open || data?.branch === branch) return
    setError(null)
    listPaths(projectKey, branch)
      .then((paths) => setData({ branch, paths }))
      .catch((err) => setError(err instanceof AppError ? err.message : 'Could not load the file list.'))
  }, [open, branch, projectKey, data?.branch])

  const q = search.trim().toLowerCase()
  const all = data?.branch === branch ? data.paths.paths : []
  const matches = (q ? all.filter((p) => p.toLowerCase().includes(q)) : all).slice(0, VISIBLE)

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-2 text-muted-foreground">
        <Search />
        <span className="hidden sm:inline">Go to file</span>
        <kbd className="pointer-events-none hidden rounded border bg-muted px-1.5 font-mono text-[10px] sm:inline">Ctrl P</kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Go to file" description="Search the files on this branch">
        {/* Filtering is done here (and capped), so cmdk's own filter is off. */}
        <Command shouldFilter={false}>
        <CommandInput placeholder="Type a file name…" value={search} onValueChange={setSearch} />
        <CommandList>
          {error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : data?.branch !== branch ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner /> Loading files…
            </div>
          ) : (
            <>
              <CommandEmpty>No file matches.</CommandEmpty>
              <CommandGroup heading={data.paths.truncated ? 'First 20,000 files' : undefined}>
                {matches.map((p) => {
                  const slash = p.lastIndexOf('/')
                  return (
                    <CommandItem
                      key={p}
                      value={p}
                      onSelect={() => {
                        setOpen(false)
                        setSearch('')
                        onOpen(p)
                      }}
                      className="gap-2"
                    >
                      <FileCode2 className="size-4 text-muted-foreground" />
                      <span className="truncate">{p.slice(slash + 1)}</span>
                      <span className="truncate text-xs text-muted-foreground">{slash > 0 ? p.slice(0, slash) : ''}</span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </>
          )}
        </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}
