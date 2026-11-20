'use client'

// My work items: everything assigned to me in Azure DevOps (read live as me), my Azure DevOps access (my own token
// or a linked Git connection) and the organisation's Azure Git connections I could use instead.

import { useState } from 'react'
import type { AdoTokenResponse, MyWorkItemsResponse } from '@sdlc/contracts'
import { AppError } from '@/appError'
import { useApiResource, type ApiResource } from '@/hooks/common/useApiResource'
import { getAdoToken, getMyWorkItems, linkAdoConnection } from '@/service/boards.service'
import { toast } from 'sonner'

export function useMyWorkItems(): ApiResource<MyWorkItemsResponse> {
  return useApiResource(getMyWorkItems, [])
}

export function useAdoToken(): ApiResource<AdoTokenResponse> {
  return useApiResource(getAdoToken, [])
}

/** "Use this connection": link it, toast the outcome, then `onLinked`. `linking` is the connection being linked. */
export function useLinkAdoConnection(onLinked: (res: AdoTokenResponse) => void | Promise<void>): {
  linking: string | null
  link: (connectionId: string) => Promise<void>
} {
  const [linking, setLinking] = useState<string | null>(null)
  async function link(connectionId: string): Promise<void> {
    setLinking(connectionId)
    try {
      const res = await linkAdoConnection(connectionId)
      toast.success(`Using ${res.token?.connectionName ?? 'the connection'} for your work items`)
      await onLinked(res)
    } catch (err) {
      toast.error(err instanceof AppError ? err.message : 'Could not use that connection.')
    } finally {
      setLinking(null)
    }
  }
  return { linking, link }
}
