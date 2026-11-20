'use client'

import { ArrowDown, ArrowUp, ChevronsUpDown, EyeOff } from 'lucide-react'
import type { Column, RowData } from '@tanstack/react-table'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { DataTableFeatures } from './features'

interface DataTableColumnHeaderProps<TData extends RowData, TValue> {
  column: Column<DataTableFeatures, TData, TValue>
  title: string
  className?: string
}

/** A sortable column header with a menu (ascending, descending, hide) — from the shadcn data-table guide. */
export function DataTableColumnHeader<TData extends RowData, TValue>({ column, title, className }: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) return <div className={className}>{title}</div>
  const sorted = column.getIsSorted()
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="-ml-2.5 h-8 data-[state=open]:bg-accent">
            <span>{title}</span>
            {sorted === 'desc' ? <ArrowDown /> : sorted === 'asc' ? <ArrowUp /> : <ChevronsUpDown />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => column.toggleSorting(false)}>
            <ArrowUp /> Ascending
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => column.toggleSorting(true)}>
            <ArrowDown /> Descending
          </DropdownMenuItem>
          {column.getCanHide() ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => column.toggleVisibility(false)}>
                <EyeOff /> Hide
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
