import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { assetFileName, createAsset, errorMessage, openAsset as openAssetCommand } from '@reflect/core'
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

  useEffect(() => {
    return () => {
      sessionEpoch.current += 1
      setSaveError(null)
    }
  }, [path, generation])

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
      try {
        const saved = await createAsset(desiredName, file, generation)
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

  return useMemo<AssetPersistence>(
    () => ({ resolveImageUrl, resolveAssetOpenPath, openAsset, saveFile, saveError }),
    [resolveImageUrl, resolveAssetOpenPath, openAsset, saveFile, saveError],
  )
}
