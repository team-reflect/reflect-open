import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { FileInfo, FileLinkPayload } from '@meowdown/core'
import {
  assetFileName,
  createAsset,
  errorMessage,
  listDir,
  openAsset as openAssetCommand,
  type FileMeta,
} from '@reflect/core'
import { formatBytes } from '@/lib/format-bytes'
import { startOperation } from '@/lib/operations'

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

/**
 * True for a graph-relative `assets/…` path with no traversal segments. The
 * Rust shell already guards every *write* against traversal; this guards
 * *display and open* resolution so a crafted `assets/../…` reference in note
 * markdown is never handed to the asset protocol or the OS opener (defense
 * in depth).
 */
function isSafeAssetSource(sourcePath: string): boolean {
  if (!sourcePath.startsWith('assets/') || sourcePath.includes('\\')) {
    return false
  }
  return sourcePath
    .split('/')
    .every((segment, index) =>
      index === 0
        ? segment === 'assets'
        : segment.length > 0 && segment !== '.' && segment !== '..',
    )
}

/**
 * Claims a `[label](url)` markdown link as a file attachment when its
 * destination is a safe graph-relative `assets/…` path, so meowdown renders
 * it as a file pill instead of a plain link. Pure by contract (meowdown
 * caches and diffs parse results), which a stateless path check satisfies.
 */
export function resolveAssetFileLink({ href }: FileLinkPayload): boolean {
  return isSafeAssetSource(href)
}

/** The failed save the pane reports on: which banner copy, and the cause. */
export interface AssetSaveError {
  /** 'image' for `image/*` files, 'file' for everything else. */
  kind: 'image' | 'file'
  message: string
}

export interface AssetPersistence {
  /** Resolve an image source to a displayable URL (or null to skip). */
  resolveImageUrl: (src: string) => string | null
  /** Vet a source as a graph-relative asset path for {@link openAsset} (null for remote/unsafe). */
  resolveAssetOpenPath: (src: string) => string | null
  /** Open a vetted graph-relative asset path in the OS default application. */
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
   * Resolve the size a file pill shows for a claimed `assets/…` link
   * (see {@link resolveAssetFileLink}); undefined for anything else or a
   * file that no longer exists.
   */
  resolveFileInfo: (href: string) => Promise<FileInfo | undefined>
  /** The most recent failed save; cleared by the next success. */
  saveError: AssetSaveError | null
}

/**
 * Asset handling for one open graph: resolve `![…](…)` sources to displayable
 * URLs (remote URLs pass through; `assets/` paths map to Tauri asset URLs),
 * open asset links in the OS viewer, and persist pasted/dropped files by
 * streaming them into the graph's `assets/` folder — Rust resolves `-2`-style
 * name collisions at write time. A save over {@link LARGE_FILE_BYTES} gets a
 * non-blocking status-line warning after it lands. `generation` pins every
 * save to the issuing graph session, so a save racing a graph switch is
 * rejected loudly instead of landing in the wrong graph; `path`, when given,
 * scopes the error banner to the note being edited (a pane is reused across
 * note switches).
 */
export function useAssetPersistence(
  graphRoot: string | null,
  generation: number | null,
  path?: string,
): AssetPersistence {
  const [saveError, setSaveError] = useState<AssetSaveError | null>(null)
  // Stamps the note session a save was started for. The pane outlives the
  // note (and graph session) it shows, so a save that finishes after a
  // switch must not put its outcome on the *next* note's banner.
  const sessionEpoch = useRef(0)
  // File-pill sizes by graph-relative asset path, seeded by every save (the
  // size is already in hand) and backfilled by one shared `assets/` listing,
  // so a note full of pills stats the directory once, not once per pill.
  const sizeByAssetPath = useRef(new Map<string, number>())
  const pendingAssetListing = useRef<Promise<FileMeta[]> | null>(null)

  useEffect(() => {
    return () => {
      sessionEpoch.current += 1
      setSaveError(null)
    }
  }, [path, generation])

  useEffect(() => {
    return () => {
      // Replace the map rather than clearing it: a listing or save still in
      // flight for the old graph session writes into the orphaned instance,
      // never into the next session's cache.
      sizeByAssetPath.current = new Map()
      pendingAssetListing.current = null
    }
  }, [generation])

  const resolveImageUrl = useCallback(
    (src: string): string | null => {
      if (/^https?:\/\//.test(src)) {
        return src
      }
      if (graphRoot && isSafeAssetSource(src)) {
        return convertFileSrc(`${graphRoot}/${src}`)
      }
      return null
    },
    [graphRoot],
  )

  const resolveAssetOpenPath = useCallback(
    (src: string): string | null => {
      if (graphRoot && generation !== null && isSafeAssetSource(src)) {
        return src
      }
      return null
    },
    [graphRoot, generation],
  )

  const openAsset = useCallback(
    async (assetPath: string): Promise<void> => {
      if (generation === null) {
        return
      }
      await openAssetCommand(assetPath, generation)
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
      const sizeCache = sizeByAssetPath.current
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
      if (generation === null || !isSafeAssetSource(href)) {
        return undefined
      }
      // Captured before the await for the same session-scoping reason as in
      // saveFile.
      const cache = sizeByAssetPath.current
      if (!cache.has(href)) {
        pendingAssetListing.current ??= listDir('assets', generation).finally(() => {
          pendingAssetListing.current = null
        })
        try {
          const entries = await pendingAssetListing.current
          for (const entry of entries) {
            cache.set(entry.path, entry.size)
          }
        } catch {
          // A failed listing degrades to a pill without a size, per the
          // documented contract (undefined, never a rejection).
          return undefined
        }
      }
      const size = cache.get(href)
      return size === undefined ? undefined : { size }
    },
    [generation],
  )

  return useMemo<AssetPersistence>(
    () => ({
      resolveImageUrl,
      resolveAssetOpenPath,
      openAsset,
      saveFile,
      resolveFileInfo,
      saveError,
    }),
    [resolveImageUrl, resolveAssetOpenPath, openAsset, saveFile, resolveFileInfo, saveError],
  )
}
