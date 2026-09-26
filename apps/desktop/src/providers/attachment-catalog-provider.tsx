import { useCallback, useEffect, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createAttachmentCatalog,
  isAttachmentPath,
  subscribeReconcileRequests,
  type AttachmentCatalog,
  type FileChange,
  type GraphInfo,
} from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { invalidateAttachmentCatalog, queryClient } from '@/lib/query-client.ts'
import { createAttachmentCatalogQueryOptions } from '@/lib/query-options.ts'
import { useFileChanges } from '@/lib/use-file-changes.ts'

type AttachmentListing = Parameters<typeof createAttachmentCatalog>[0]

// One catalog per listing, so a lookup never re-indexes an unchanged listing.
const catalogs = new WeakMap<AttachmentListing, AttachmentCatalog>()

function catalogFor(listing: AttachmentListing): AttachmentCatalog {
  let catalog = catalogs.get(listing)
  if (catalog === undefined) {
    catalog = createAttachmentCatalog(listing)
    catalogs.set(listing, catalog)
  }
  return catalog
}

/** The attachment catalog for a graph session, or null while its first listing loads. */
export function peekAttachmentCatalog(generation: number): AttachmentCatalog | null {
  const listing = queryClient.getQueryData(createAttachmentCatalogQueryOptions(generation).queryKey)
  return listing === undefined ? null : catalogFor(listing)
}

/** The attachment catalog for a graph session, waiting for the first listing. */
export async function loadAttachmentCatalog(generation: number): Promise<AttachmentCatalog> {
  return catalogFor(await queryClient.fetchQuery(createAttachmentCatalogQueryOptions(generation)))
}

interface AttachmentCatalogProviderProps {
  graph: GraphInfo
  children: ReactNode
}

/**
 * Keeps the open graph's attachment catalog loaded for {@link peekAttachmentCatalog}:
 * one listing per graph session, re-listed when the watcher reports an
 * attachment appearing or disappearing, or a folder change only a re-listing
 * can explain. The query subscription is what makes an invalidation refetch.
 */
export function AttachmentCatalogProvider({
  graph,
  children,
}: AttachmentCatalogProviderProps): ReactNode {
  const bridgeReady = useBridgeReady()
  useQuery({ ...createAttachmentCatalogQueryOptions(graph.generation), enabled: bridgeReady })

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

  return children
}
