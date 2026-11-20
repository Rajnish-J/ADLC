import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { initials } from '@/utils/format'

export function UserAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <Avatar className={cn('size-6', className)} title={name}>
      <AvatarFallback className="bg-accent text-[10px] font-semibold text-accent-foreground">{initials(name)}</AvatarFallback>
    </Avatar>
  )
}
