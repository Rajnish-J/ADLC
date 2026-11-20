'use client'

// Client-only entry points for Monaco (it touches `window`), so the Code page still server-renders its frame.

import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'

const placeholder = () => <Skeleton className="h-full w-full rounded-none" />

export const CodeEditor = dynamic(() => import('./MonacoImpl').then((m) => m.CodeEditor), { ssr: false, loading: placeholder })
export const CodeDiff = dynamic(() => import('./MonacoImpl').then((m) => m.CodeDiff), { ssr: false, loading: placeholder })
