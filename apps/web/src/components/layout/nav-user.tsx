'use client'

// sidebar-07's user menu: who you are, the theme, and signing out (then in as someone else).

import { ChevronsUpDown, LogOut, Monitor, Moon, Palette, Settings, Sun } from 'lucide-react'
import Link from 'next/link'
import { useTheme } from 'next-themes'
import type { Me } from '@sdlc/contracts'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { useSession } from '@/components/providers/SessionProvider'
import { initials } from '@/utils/format'

function Identity({ me }: { me: Me }) {
  return (
    <>
      <Avatar className="size-8 rounded-lg">
        <AvatarFallback className="rounded-lg bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
          {initials(me.user.displayName)}
        </AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{me.user.displayName}</span>
        <span className="truncate text-xs text-muted-foreground">
          {me.user.orgRole === 'org_admin' ? 'Org admin' : me.user.email}
        </span>
      </div>
    </>
  )
}

export function NavUser({ me }: { me: Me }) {
  const { isMobile } = useSidebar()
  const { signOut } = useSession()
  const { theme, setTheme } = useTheme()

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
              <Identity me={me} />
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56" side={isMobile ? 'bottom' : 'right'} align="end" sideOffset={4}>
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Identity me={me} />
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <Settings /> Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Palette /> Theme
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
                  <DropdownMenuRadioItem value="light">
                    <Sun /> Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <Moon /> Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <Monitor /> System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
