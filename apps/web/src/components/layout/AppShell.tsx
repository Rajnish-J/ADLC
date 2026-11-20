'use client'

// The app frame (sidebar-07): session and live events, the collapsible sidebar, and the inset page with its
// header (trigger, breadcrumbs, live status, theme), the run monitor docked on the right, and the minimized
// run pill floating bottom-right. The sign-in page renders
// without the frame.

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { LiveEventsProvider } from '@/components/providers/LiveEventsProvider'
import { SessionProvider, useSession } from '@/components/providers/SessionProvider'
import { RunComposerProvider } from '@/components/work/RunComposerProvider'
import { RunMonitorDock } from '@/components/runs/monitor/RunMonitor'
import { RunMonitorProvider } from '@/components/runs/monitor/RunMonitorProvider'
import { RunPill } from '@/components/runs/monitor/RunPill'
import { AppSidebar } from './app-sidebar'
import { CurrentProjectProvider } from './current-project'
import { SiteHeader } from './site-header'

/**
 * Pages that manage their own height and scrolling: the chat keeps its composer pinned to the bottom, and the
 * workflow editor fills the window with its palette, canvas and inspector.
 */
const FULL_HEIGHT = [/^\/chat$/, /^\/projects\/[^/]+\/workflow\/(new|[^/]+\/edit)$/]

function SignedInShell({ children }: { children: ReactNode }) {
  const { me } = useSession()
  const pathname = usePathname()
  const fullHeight = FULL_HEIGHT.some((re) => re.test(pathname))
  return (
    <LiveEventsProvider enabled={Boolean(me)}>
      <CurrentProjectProvider>
        <RunComposerProvider>
        <RunMonitorProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset className={fullHeight ? 'h-svh min-w-0 overflow-hidden' : 'min-w-0'}>
            <SiteHeader />
            {fullHeight ? (
              <div className="@container/main flex min-h-0 flex-1 flex-col">{children}</div>
            ) : (
              <div className="@container/main flex flex-1 flex-col gap-6 p-4 pt-2 md:p-6 md:pt-2">{children}</div>
            )}
          </SidebarInset>
          {/* Follows your workflow runs on every page: a run never depends on the page you are on. */}
          <RunMonitorDock />
          {/* The minimized run, bottom-right on every other page: one click back to the run. */}
          <RunPill />
        </SidebarProvider>
        </RunMonitorProvider>
        </RunComposerProvider>
      </CurrentProjectProvider>
    </LiveEventsProvider>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return (
    <SessionProvider>{pathname === '/login' ? children : <SignedInShell>{children}</SignedInShell>}</SessionProvider>
  )
}
