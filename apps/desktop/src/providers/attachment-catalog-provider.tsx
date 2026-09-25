import {
  createContext,
  use,
  useCallback,
  useEffect,
  type ReactElement,
  type ReactNode,
} from 'react'
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

const AttachmentCatalogContext = createContext<AttachmentCatalog | null>(null)

type AttachmentListing = Parameters<typeof createAttachmentCatalog>[0]

// One catalog per listing: structural sharing hands back the same listing
// array while nothing changed, so the catalog (and every resolver built on
// it) keeps its identity too.
const catalogs = new WeakMap<AttachmentListing, AttachmentCatalog>()

function catalogFor(listing: AttachmentListing): AttachmentCatalog {
  let catalog = catalogs.get(listing)
  if (catalog === undefined) {
    catalog = createAttachmentCatalog(listing)
    catalogs.set(listing, catalog)
  }
  return catalog
}

/**
 * The attachment catalog for a graph session, waiting for the first listing
 * when it has not arrived yet — for async consumers (file-pill sizes) that
 * would otherwise resolve against no catalog at all.
 */
export async function loadAttachmentCatalog(generation: number): Promise<AttachmentCatalog> {
  return catalogFor(await queryClient.fetchQuery(createAttachmentCatalogQueryOptions(generation)))
}

interface AttachmentCatalogProviderProps {
  graph: GraphInfo
  children: ReactNode
}

/**
 * Holds the open graph's attachment catalog, which display-time resolution of
 * images, `![[embeds]]`, and attachment links reads (`useNoteAttachments`).
 * One listing per graph session, re-listed when the watcher reports an
 * attachment appearing or disappearing, or a folder change only a re-listing
 * can explain. A single subscription serves every open editor and preview.
 */
export function AttachmentCatalogProvider({
  graph,
  children,
}: AttachmentCatalogProviderProps): ReactElement {
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    ...createAttachmentCatalogQueryOptions(graph.generation),
    enabled: bridgeReady,
  })
  const catalog = data === undefined ? null : catalogFor(data)

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

  return <AttachmentCatalogContext value={catalog}>{children}</AttachmentCatalogContext>
}

/**
 * The open graph's attachment catalog, or null while it first loads (and
 * outside an {@link AttachmentCatalogProvider}). Resolution degrades to each
 * reference's vault-root reading until it arrives.
 */
export function useAttachmentCatalog(): AttachmentCatalog | null {
  return use(AttachmentCatalogContext)
}
