'use client'

// A reusable data table (shadcn data-table guide, TanStack Table v9): sortable headers, a search box over one
// column, column visibility, pagination, optional extra toolbar filters and row click-through.

import { useState, type ReactNode } from 'react'
import {
  FlexRender,
  useTable,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type RowData,
  type SortingState,
} from '@tanstack/react-table'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Search, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { features, type DataTableFeatures } from './features'

interface DataTableProps<TData extends RowData> {
  columns: ColumnDef<DataTableFeatures, TData>[]
  data: TData[]
  /** Column id the search box filters (substring match). Omit to hide the search box. */
  searchColumn?: string
  searchPlaceholder?: string
  /** Extra filter controls rendered next to the search box. */
  toolbar?: ReactNode
  onRowClick?: (row: TData) => void
  emptyMessage?: string
  pageSize?: number
  initialSorting?: SortingState
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  searchColumn,
  searchPlaceholder = 'Search…',
  toolbar,
  onRowClick,
  emptyMessage = 'No results.',
  pageSize = 10,
  initialSorting = [],
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting)
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({})

  const table = useTable({
    features,
    data,
    columns,
    initialState: { pagination: { pageIndex: 0, pageSize } },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    state: { sorting, columnFilters, columnVisibility },
  })

  const searchCol = searchColumn ? table.getColumn(searchColumn) : undefined
  const rows = table.getRowModel().rows
  const { pageIndex, pageSize: size } = table.state.pagination
  const total = table.getFilteredRowModel().rows.length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {searchCol ? (
          <InputGroup className="w-full sm:w-64">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              placeholder={searchPlaceholder}
              value={(searchCol.getFilterValue() as string | undefined) ?? ''}
              onChange={(e) => searchCol.setFilterValue(e.target.value)}
            />
          </InputGroup>
        ) : null}
        {toolbar}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto hidden lg:flex">
              <Settings2 />
              View
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table
              .getAllColumns()
              .filter((c) => c.getCanHide())
              .map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  className="capitalize"
                  checked={c.getIsVisible()}
                  onCheckedChange={(v) => c.toggleVisibility(Boolean(v))}
                >
                  {c.id}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted/50">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id} colSpan={header.colSpan}>
                    {header.isPlaceholder ? null : <FlexRender header={header} />}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length > 0 ? (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={cn(onRowClick && 'cursor-pointer')}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
        <span>
          {total} {total === 1 ? 'row' : 'rows'}
        </span>
        <div className="flex items-center gap-4">
          <div className="hidden items-center gap-2 sm:flex">
            <span>Rows per page</span>
            <Select value={String(size)} onValueChange={(v) => table.setPageSize(Number(v))}>
              <SelectTrigger size="sm" className="w-18">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top">
                {[10, 20, 50].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <span className="tabular-nums">
            Page {table.getPageCount() === 0 ? 0 : pageIndex + 1} of {table.getPageCount()}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon-sm" className="hidden sm:flex" onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()} aria-label="First page">
              <ChevronsLeft />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page">
              <ChevronRight />
            </Button>
            <Button variant="outline" size="icon-sm" className="hidden sm:flex" onClick={() => table.setPageIndex(table.getPageCount() - 1)} disabled={!table.getCanNextPage()} aria-label="Last page">
              <ChevronsRight />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
