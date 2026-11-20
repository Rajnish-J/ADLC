'use client'

import type { ComponentProps } from 'react'
import { ThemeProvider as NextThemesProvider } from 'next-themes'

/** Light / dark / system theme via the `.dark` class on <html> (next-themes). */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
