import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  FileInfo,
  FileLinkResolver,
  ImageUrlResolver,
  WikiEmbedResolver,
} from '@meowdown/core'
import {
  assetFileName,
  createAsset,
  errorMessage,
  openAsset as openAssetCommand,
  resolveAttachmentLink,
  revealAsset as revealAssetCommand,
} from '@reflect/core'
import { useNoteAttachments } from '@/editor/use-note-attachments.ts'
import { formatBytes } from '@/lib/format-bytes.ts'
import { startOperation } from '@/lib/operations.ts'
import { loadAttachmentCatalog } from '@/providers/attachment-catalog-provider.tsx'

/**
 * Above this size, a save gets a non-blocking status-line warning. Never a
 * wall (it's the user's disk), and not a modal either — the drop already
 * said what the user wants — but git backup is the quiet constraint: every
 * binary lives in history forever, and GitHub hard-rejects files over
 * 100 MB, so the size is worth a mention.
 */
export const LARGE_FILE_BYTES = 25 * 1024 * 1024

/** Asset file extension for each image MIME type that gets `pasted-…` naming. */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/** The failed save the pane reports on: which banner copy, and the cause. */
export interface AssetSaveError {
  /** 'image' for `image/*` files, 'file' for everything else. */
  kind: 'image' | 'file'
  message: string
}

export interface AssetPersistence {
  /** Resolve an image source in the note to a displayable URL, possibly later. */
  resolveImageUrl: ImageUrlResolver
  /**
   * Resolve an image source or link destination in the note to the
   * graph-relative attachment {@link openAsset} opens (null for remote,
   * note, and unsafe destinations).
   */
  resolveAssetOpenPath: (src: string) => string | null
  /** Classify the note's `![[embeds]]` (see `useNoteAttachments`). */
  resolveWikiEmbed: WikiEmbedResolver
  /** Claim the note's links to local attachments as file pills. */
  resolveFileLink: FileLinkResolver
  /**
   * Open a vetted graph-relative asset path in the OS default application.
   * A refused file type degrades to revealing the file in the OS file
   * manager; a failed open surfaces on the status line, never a rejection.
   */
  openAsset: (path: string) => Promise<void>
  /**
   * Persist a pasted/dropped file into `assets/`, returning its graph-relative
   * path — or null when declined, failed (the failure lands on
   * {@link AssetPersistence.saveError}, never a throw), or no graph is open.
   * Images get `pasted-…` names (screenshots have no meaningful name);
   * everything else keeps its original filename, sanitized, since the name
   * is the visible link text.
   */
  saveFile: (file: File) => Promise<string | null>
  /**
   * Resolve the size a file pill shows for a claimed attachment link or
   * embed; undefined for anything else or a file the catalog doesn't list.
   */
  resolveFileInfo: (href: string) => Promise<FileInfo | undefined>
  /** The most recent failed save; cleared by the next success. */
  saveError: AssetSaveError | null
}

/**
 * Asset handling for the note at `path` in one open graph: resolve its images,
 * embeds, and attachment links from the note's own folder
 * ({@link useNoteAttachments}; local files become `reflect-asset://` URLs
 * served off the UI thread by the Rust shell), open attachments in the OS
 * viewer, and persist pasted/dropped files by streaming them into the graph's
 * `assets/` folder — Rust resolves `-2`-style name collisions at write time.
 * A save over {@link LARGE_FILE_BYTES} gets a non-blocking status-line warning
 * after it lands. `generation` pins every save — and every image URL — to the
 * issuing graph session, so a save or image load racing a graph switch is
 * rejected loudly instead of landing in (or reading from) the wrong graph;
 * `path` also scopes the error banner to the note being edited (a pane is
 * reused across note switches).
 */
export function useAssetPersistence(generation: number | null, path: string): AssetPersistence {
  const [saveError, setSaveError] = useState<AssetSaveError | null>(null)
  // Stamps the note session a save was started for. The pane outlives the
  // note (and graph session) it shows, so a save that finishes after a
  // switch must not put its outcome on the *next* note's banner.
  const sessionEpoch = useRef(0)
  // File-pill sizes of this session's saves, by graph-relative asset path:
  // the size is already in hand, while the attachment catalog only lists the
  // file once the watcher reports it.
  const savedSizes = useRef(new Map<string, number>())
  const { resolveAttachmentPath, resolveImageUrl, resolveWikiEmbed, resolveFileLink } =
    useNoteAttachments(generation, path)

  useEffect(() => {
    return () => {
      sessionEpoch.current += 1
      setSaveError(null)
    }
  }, [path, generation])

  useEffect(() => {
    return () => {
      // Replace the map rather than clearing it: a save still in flight for
      // the old graph session writes into the orphaned instance, never into
      // the next session's cache.
      savedSizes.current = new Map()
    }
  }, [generation])

  const openAsset = useCallback(
    async (assetPath: string): Promise<void> => {
      if (generation === null) {
        return
      }
      try {
        await openAssetCommand(assetPath, generation)
      } catch (openCause) {
        // A refused file type still deserves a visible outcome: fall back to
        // the file manager. When even the reveal fails (missing or evicted
        // file), report the original open error — that is the user's intent.
        try {
          await revealAssetCommand(assetPath, generation)
          startOperation('Opening attachment').warn(
            'This file type can’t be opened directly, so it was revealed in Finder instead.',
          )
        } catch {
          startOperation('Opening attachment').fail(errorMessage(openCause))
        }
      }
    },
    [generation],
  )

  const saveFile = useCallback(
    async (file: File): Promise<string | null> => {
      if (generation === null) {
        return null
      }
      const epoch = sessionEpoch.current
      const isStale = (): boolean => sessionEpoch.current !== epoch
      const imageExtension = EXTENSION_BY_MIME[file.type]
      // Rust owns collision suffixes, so two pastes in the same millisecond
      // land as `pasted-<ts>.png` and `pasted-<ts>-2.png`.
      const desiredName = imageExtension
        ? `pasted-${Date.now()}.${imageExtension}`
        : assetFileName(file.name)
      // Captured before the await: a save resolving after a graph switch
      // seeds the orphaned session's cache, not the next graph's.
      const sizeCache = savedSizes.current
      try {
        const saved = await createAsset(desiredName, file, generation)
        sizeCache.set(saved, file.size)
        if (file.size > LARGE_FILE_BYTES) {
          startOperation('Large file added').warn(
            `“${file.name}” is ${formatBytes(file.size)}. Git keeps every version forever; GitHub rejects files over 100 MB.`,
          )
        }
        if (!isStale()) {
          setSaveError(null)
        }
        return saved
      } catch (cause) {
        // Owned here (not thrown to meowdown's error callback) so a save
        // finishing late can be dropped instead of blaming the next note.
        // The kind mirrors the naming decision above: an image MIME without
        // a known extension was saved as a named attachment, so its failure
        // reads as a file, not a "pasted image".
        if (!isStale()) {
          setSaveError({
            kind: imageExtension ? 'image' : 'file',
            message: errorMessage(cause),
          })
        }
        return null
      }
    },
    [generation],
  )

  const resolveFileInfo = useCallback(
    async (href: string): Promise<FileInfo | undefined> => {
      if (generation === null) {
        return undefined
      }
      const saved = savedSizes.current
      try {
        // Waits for the first listing, so a pill rendered before the catalog
        // arrived still resolves the file (and size) it will display.
        const catalog = await loadAttachmentCatalog(generation)
        const assetPath = resolveAttachmentLink(path, href, catalog)
        const size =
          assetPath === null ? undefined : (saved.get(assetPath) ?? catalog.size(assetPath))
        return size === undefined ? undefined : { size }
      } catch {
        // A failed listing degrades to a pill without a size, per the
        // documented contract (undefined, never a rejection).
        return undefined
      }
    },
    [generation, path],
  )

  return useMemo<AssetPersistence>(
    () => ({
      resolveImageUrl,
      resolveAssetOpenPath: resolveAttachmentPath,
      resolveWikiEmbed,
      resolveFileLink,
      openAsset,
      saveFile,
      resolveFileInfo,
      saveError,
    }),
    [
      resolveImageUrl,
      resolveAttachmentPath,
      resolveWikiEmbed,
      resolveFileLink,
      openAsset,
      saveFile,
      resolveFileInfo,
      saveError,
    ],
  )
}
