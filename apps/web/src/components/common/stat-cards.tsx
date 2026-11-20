// The dashboard-01 "section cards" pattern: a label, a big number, an optional badge and a footer line. Two
// per row on phones (badge and footer detail drop out when a card is narrow), four on wide screens.

import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import type { BadgeVariant } from '@/utils/status'

export interface StatItem {
  label: string
  value: number | string
  badge?: { label: string; icon?: ReactNode; variant?: BadgeVariant }
  footer?: { title: ReactNode; description?: ReactNode }
}

export function StatCards({ items }: { items: StatItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:gap-4 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      {items.map((item) => (
        <Card key={item.label} className="@container/card">
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <CardDescription>{item.label}</CardDescription>
              {item.badge ? (
                <Badge variant={item.badge.variant ?? 'outline'} className="hidden @[240px]/card:inline-flex">
                  {item.badge.icon}
                  {item.badge.label}
                </Badge>
              ) : null}
            </div>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">{item.value}</CardTitle>
          </CardHeader>
          {item.footer ? (
            <CardFooter className="flex-col items-start gap-1 text-sm">
              <div className="line-clamp-2 font-medium @[260px]/card:line-clamp-1">{item.footer.title}</div>
              {item.footer.description ? <div className="hidden text-muted-foreground @[260px]/card:block">{item.footer.description}</div> : null}
            </CardFooter>
          ) : null}
        </Card>
      ))}
    </div>
  )
}
