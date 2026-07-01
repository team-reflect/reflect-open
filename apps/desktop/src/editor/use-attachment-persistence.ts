import { useCallback, useMemo, useState } from 'react'
import { assetFileName, createAsset, errorMessage } from '@reflect/core'

/**
 * Above this size, saving pauses on a confirm. Not a wall — it's the user's
 * disk — but git backup is the quiet constraint: every binary lives in
 * history forever, and GitHub hard-rejects files over 100 MB.
 */
export const LARGE_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** A large file waiting on the user's go-ahead; drives the confirm dialog. */
export interface PendingLargeAttachment {
  file: File
  /** Resolve the paused save: `true` writes the file, `false` drops it. */
  respond: (proceed: boolean) => void
}

export interface AttachmentPersistence {
  /**
   * Persist a pasted/dropped non-image file into `assets/`, returning its
   * graph-relative path (or null when declined or no graph is open).
   */
  saveAttachment: (file: File) => Promise<string | null>
  /** Report a failed attachment save. */
  onAttachmentSaveError: (error: unknown) => void
  /** Message of the most recent failed save; cleared by the next success. */
  saveError: string | null
  /** Set while a save waits on the large-file confirm; null otherwise. */
  pendingLargeAttachment: PendingLargeAttachment | null
}

/**
 * Attachment handling for one open graph: files that aren't images stream
 * into `assets/` under their original (sanitized) filename — the name is the
 * visible link text — with Rust resolving `-2`-style collisions. Files over
 * {@link LARGE_ATTACHMENT_BYTES} first surface on
 * {@link AttachmentPersistence.pendingLargeAttachment} for an explicit
 * go-ahead. `generation` pins every save to the issuing graph session,
 * mirroring `useImagePersistence`.
 */
export function useAttachmentPersistence(generation: number | null): AttachmentPersistence {
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pendingLargeAttachment, setPendingLargeAttachment] =
    useState<PendingLargeAttachment | null>(null)

  const confirmLargeFile = useCallback(
    (file: File) =>
      new Promise<boolean>((resolve) => {
        setPendingLargeAttachment({
          file,
          respond: (proceed) => {
            setPendingLargeAttachment(null)
            resolve(proceed)
          },
        })
      }),
    [],
  )

  const saveAttachment = useCallback(
    async (file: File): Promise<string | null> => {
      if (generation === null) {
        return null
      }
      if (file.size > LARGE_ATTACHMENT_BYTES && !(await confirmLargeFile(file))) {
        return null
      }
      const path = await createAsset(assetFileName(file.name), file, generation)
      setSaveError(null)
      return path
    },
    [generation, confirmLargeFile],
  )

  const onAttachmentSaveError = useCallback((error: unknown) => {
    setSaveError(errorMessage(error))
  }, [])

  return useMemo<AttachmentPersistence>(
    () => ({ saveAttachment, onAttachmentSaveError, saveError, pendingLargeAttachment }),
    [saveAttachment, onAttachmentSaveError, saveError, pendingLargeAttachment],
  )
}
