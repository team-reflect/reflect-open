import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  attachmentPathSchema,
  errorMessage,
  listAttachments,
  prepareAttachmentCatalog,
  subscribeFileCatalogChanged,
  subscribeFileChanges,
  type AttachmentCatalogResolveOutcome,
  type AttachmentFileMeta,
  type AttachmentReference,
} from '@reflect/core'

interface AttachmentCatalogValue {
  /** Increments after each accepted manifest refresh. */
  readonly revision: number
  /** Resolve through the latest generation-pinned manifest. Stable by identity. */
  readonly resolve: (reference: AttachmentReference) => AttachmentCatalogResolveOutcome
  /** Latest metadata for one resolved graph-relative path. Stable by identity. */
  readonly metadataForPath: (path: string) => AttachmentFileMeta | undefined
}

const AttachmentCatalogContext = createContext<AttachmentCatalogValue | null>(null)

function normalizeManifest(files: readonly AttachmentFileMeta[]): readonly AttachmentFileMeta[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path))
}

function sameManifest(
  left: readonly AttachmentFileMeta[],
  right: readonly AttachmentFileMeta[],
): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => {
      const other = right[index]
      return (
        other !== undefined &&
        file.path === other.path &&
        file.size === other.size &&
        file.modifiedMs === other.modifiedMs &&
        file.placeholder === other.placeholder
      )
    })
  )
}

/**
 * Keep one attachment manifest for the mounted graph generation. Children
 * render immediately; when the initial background scan or a later filesystem
 * refresh lands, resolver-backed editors can reparse without changing bytes.
 */
export function AttachmentCatalogProvider({
  generation,
  children,
}: {
  generation: number
  children: ReactNode
}) {
  const filesRef = useRef<readonly AttachmentFileMeta[]>([])
  const catalogRef = useRef(prepareAttachmentCatalog([]))
  const [revision, setRevision] = useState(0)

  const resolve = useCallback(
    (reference: AttachmentReference): AttachmentCatalogResolveOutcome =>
      catalogRef.current.resolve(reference),
    [],
  )
  const metadataForPath = useCallback(
    (path: string): AttachmentFileMeta | undefined =>
      catalogRef.current.metadataForPath(path),
    [],
  )

  useEffect(() => {
    let disposed = false
    let requestSequence = 0
    let unlistenFileChanges: (() => void) | null = null
    let unlistenCatalogChanges: (() => void) | null = null

    const acceptManifest = (files: readonly AttachmentFileMeta[]): void => {
      const normalized = normalizeManifest(files)
      if (sameManifest(filesRef.current, normalized)) {
        return
      }
      filesRef.current = normalized
      catalogRef.current = prepareAttachmentCatalog(normalized)
      setRevision((current) => current + 1)
    }

    const refresh = (): void => {
      const request = ++requestSequence
      void listAttachments(generation).then(
        (files) => {
          if (disposed || request !== requestSequence) {
            return
          }
          acceptManifest(files)
        },
        (cause: unknown) => {
          if (!disposed && request === requestSequence) {
            // A stale positive match is unsafe: a failed refresh may be the
            // exact moment a second basename appeared or an iCloud item was
            // evicted. Clear the snapshot until a later event proves the
            // current manifest instead of continuing to resolve from history.
            acceptManifest([])
            console.error('attachment catalog refresh failed:', errorMessage(cause))
          }
        },
      )
    }

    void (async () => {
      try {
        unlistenFileChanges = await subscribeFileChanges((changes) => {
          if (changes.some((change) => attachmentPathSchema.safeParse(change.path).success)) {
            refresh()
          }
        })
        if (disposed) {
          unlistenFileChanges()
          unlistenFileChanges = null
          return
        }
        unlistenCatalogChanges = await subscribeFileCatalogChanged((change) => {
          if (change.generation === generation) {
            refresh()
          }
        })
        if (disposed) {
          unlistenCatalogChanges()
          unlistenCatalogChanges = null
          unlistenFileChanges?.()
          unlistenFileChanges = null
          return
        }
        // Take the first snapshot only after both event streams are live. This
        // final catch-up closes the subscribe/list race without an event buffer.
        refresh()
      } catch (cause: unknown) {
        unlistenCatalogChanges?.()
        unlistenCatalogChanges = null
        unlistenFileChanges?.()
        unlistenFileChanges = null
        if (!disposed) {
          acceptManifest([])
          console.error('attachment catalog subscription failed:', errorMessage(cause))
        }
      }
    })()

    return () => {
      disposed = true
      requestSequence += 1
      unlistenCatalogChanges?.()
      unlistenCatalogChanges = null
      unlistenFileChanges?.()
      unlistenFileChanges = null
    }
  }, [generation])

  const value = useMemo<AttachmentCatalogValue>(
    () => ({ revision, resolve, metadataForPath }),
    [metadataForPath, resolve, revision],
  )

  return (
    <AttachmentCatalogContext.Provider value={value}>
      {children}
    </AttachmentCatalogContext.Provider>
  )
}

/** The active attachment catalog, or null in isolated/editor-only surfaces. */
export function useAttachmentCatalog(): AttachmentCatalogValue | null {
  return useContext(AttachmentCatalogContext)
}
