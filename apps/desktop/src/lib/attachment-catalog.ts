import { useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  isAttachmentPath,
  subscribeReconcileRequests,
  type AttachmentCatalog,
  type FileChange,
} from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { invalidateAttachmentCatalog, queryClient } from '@/lib/query-client.ts'
import { createAttachmentCatalogQueryOptions } from '@/lib/query-options.ts'
import { useFileChanges } from '@/lib/use-file-changes.ts'

/** The graph session's attachment catalog, or null while its first listing loads. */
export function peekAttachmentCatalog(generation: number): AttachmentCatalog | null {
  return queryClient.getQueryData(createAttachmentCatalogQueryOptions(generation).queryKey) ?? null
}

/** The graph session's attachment catalog, waiting for its first listing. */
export function loadAttachmentCatalog(generation: number): Promise<AttachmentCatalog> {
  return queryClient.fetchQuery(createAttachmentCatalogQueryOptions(generation))
}

/**
 * Keeps the open graph session's attachment catalog loaded for
 * {@link peekAttachmentCatalog}: listed once, re-listed when the watcher
 * reports an attachment appearing or disappearing, or a folder change only a
 * re-listing can explain. The query subscription is what makes an
 * invalidation refetch.
 */
export function useAttachmentCatalogSync(generation: number | null): void {
  const bridgeReady = useBridgeReady()
  useQuery({
    ...createAttachmentCatalogQueryOptions(generation ?? 0),
    enabled: bridgeReady && generation !== null,
  })

  useFileChanges(
    useCallback((changes: FileChange[]) => {
      if (changes.some((change) => isAttachmentPath(change.path))) {
        invalidateAttachmentCatalog()
      }
    }, []),
  )

  useEffect(() => {
    if (!bridgeReady) {
      return
    }
    let unlisten: (() => void) | null = null
    let disposed = false
    subscribeReconcileRequests(invalidateAttachmentCatalog).then(
      (stop) => {
        if (disposed) {
          stop()
        } else {
          unlisten = stop
        }
      },
      (error: unknown) => console.error('attachment catalog reconcile subscription failed:', error),
    )
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [bridgeReady])
}
