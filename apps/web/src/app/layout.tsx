import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Inter } from 'next/font/google'
import { AppShell } from '@/components/layout/AppShell'
import { ThemeProvider } from '@/components/common/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' })

export const metadata: Metadata = {
  title: 'SDLC Platform',
  description: 'Projects, user stories and AI agents across the software development lifecycle.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={cn('font-sans', inter.variable)}>
      <body className="min-h-svh">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider>
            <AppShell>{children}</AppShell>
          </TooltipProvider>
          {/* Lifted above the minimized run pill (RunPill), which sits bottom-right on desktop. */}
          <Toaster position="bottom-right" offset={{ bottom: 88 }} />
        </ThemeProvider>
      </body>
    </html>
  )
}
