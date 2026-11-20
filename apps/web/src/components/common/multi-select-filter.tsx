'use client'

// A toolbar filter like "Priority ▾": a popover of checkable options (searchable when the list is long). The
// trigger shows how many are picked; "Clear" resets it. Options may carry a count (how many items have it).

import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface FilterOption {
  value: string
  label: string
  icon?: ReactNode
  /** Shown at the right, e.g. how many items have this value. */
  count?: number
  /** Hover text (e.g. a full path when the label is shortened). */
  title?: string
}

interface Props {
  label: string
  icon?: ReactNode
  options: FilterOption[]
  selected: string[]
  onChange: (values: string[]) => void
  /** `ghost` for a borderless toolbar (Azure DevOps style); default `outline`. */
  variant?: 'outline' | 'ghost'
  /** Popover width class (default `w-56`). */
  contentClassName?: string
}

export function MultiSelectFilter({ label, icon, options, selected, onChange, variant = 'outline', contentClassName }: Props) {
  const toggle = (value: string): void =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={variant}
          className={cn(variant === 'ghost' && selected.length > 0 && 'bg-accent font-semibold')}
          aria-label={selected.length > 0 ? `${label}: ${selected.length} selected` : label}
        >
          {icon}
          {label}
          {selected.length > 0 ? (
            <Badge variant="secondary" className="h-4.5 min-w-4.5 rounded-full px-1 tabular-nums">
              {selected.length}
            </Badge>
          ) : null}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn('w-56 p-0', contentClassName)}>
        <Command>
          {options.length > 7 ? <CommandInput placeholder={`Search ${label.toLowerCase()}…`} /> : null}
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.value} value={`${o.label} ${o.value}`} title={o.title} data-checked={selected.includes(o.value)} onSelect={() => toggle(o.value)}>
                  {o.icon}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.count !== undefined ? <span className="ml-auto pl-2 text-xs tabular-nums text-muted-foreground">{o.count}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
            {selected.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem value="__clear__" onSelect={() => onChange([])} className="justify-center text-muted-foreground">
                    Clear
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
