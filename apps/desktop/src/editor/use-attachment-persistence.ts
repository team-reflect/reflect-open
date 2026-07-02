import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
 * mirroring `useImagePersistence`; `path` scopes the transient state — the
 * pane instance is reused across note switches, so a confirm or error that
 * belongs to the previous note is declined/cleared when `path` changes
 * rather than carried into the next note.
 */
export function useAttachmentPersistence(
  path: string,
  generation: number | null,
): AttachmentPersistence {
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pendingLargeAttachment, setPendingLargeAttachment] =
    useState<PendingLargeAttachment | null>(null)
  // Confirms queue behind one another: there is a single dialog slot, and a
  // second large file arriving while one is pending (two quick drops) must
  // wait its turn, not overwrite the slot and strand the first save
  // awaiting a `respond` that no longer has a dialog. Null when no confirm
  // is in flight — the next one then takes the slot synchronously.
  const confirmTail = useRef<Promise<boolean> | null>(null)
  // Mirror of the pending state for the path-change cleanup, plus an epoch
  // stamp so confirms queued for the previous note resolve declined instead
  // of surfacing a dialog for a note that is no longer on screen.
  const pendingRef = useRef<PendingLargeAttachment | null>(null)
  const noteEpoch = useRef(0)

  useEffect(() => {
    return () => {
      // The pane outlives the note it shows: a note switch reuses this hook
      // while the editor remounts — and a graph switch can keep the very
      // same routed path (daily notes exist in every graph). Whatever the
      // previous note had in flight — a visible confirm, confirms queued
      // behind it, an error banner — must not leak into the next one:
      // decline and clear it all. (An approved-but-unsent save would be
      // rejected by the stale generation pin anyway; declining here spares
      // the user that confusing error.)
      noteEpoch.current += 1
      pendingRef.current?.respond(false)
      setSaveError(null)
    }
  }, [path, generation])

  const confirmLargeFile = useCallback((file: File): Promise<boolean> => {
    const epoch = noteEpoch.current
    const show = () =>
      new Promise<boolean>((resolve) => {
        if (noteEpoch.current !== epoch) {
          // The note switched while this confirm waited in the queue.
          resolve(false)
          return
        }
        const pending: PendingLargeAttachment = {
          file,
          respond: (proceed) => {
            pendingRef.current = null
            setPendingLargeAttachment(null)
            resolve(proceed)
          },
        }
        pendingRef.current = pending
        setPendingLargeAttachment(pending)
      })
    const turn = confirmTail.current === null ? show() : confirmTail.current.then(show)
    confirmTail.current = turn
    void turn.finally(() => {
      if (confirmTail.current === turn) {
        confirmTail.current = null
      }
    })
    return turn
  }, [])

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
