import { useCallback, useMemo, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { assetPath, errorMessage, writeAsset } from '@reflect/core'
import type { ImageOptions } from './images'

/** Asset file extension for each image MIME type the editor accepts on paste/drop. */
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
 * *display* resolution so a crafted `assets/../…` reference in note markdown is
 * never handed to the asset protocol (defense in depth).
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

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  // Encode in 32 KiB chunks: spreading the whole buffer into String.fromCharCode
  // would exceed the engine's argument-count limit on large images.
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export interface ImagePersistence {
  /** Wiring for the editor's image extension (resolve, save, error reporting). */
  options: ImageOptions
  /** Message of the most recent failed image save; cleared by the next success. */
  saveError: string | null
}

/**
 * Image handling for one open graph: resolve `![…](…)` sources to displayable
 * URLs (remote URLs pass through; `assets/` paths map to Tauri asset URLs) and
 * persist pasted/dropped images into the graph's `assets/` folder, pinned to
 * `generation` so a save racing a graph switch can't land in the wrong graph.
 * A failed save surfaces on {@link ImagePersistence.saveError} so the pane can
 * tell the user the image was not stored.
 */
export function useImagePersistence(
  graphRoot: string | null,
  generation: number | null,
): ImagePersistence {
  const [saveError, setSaveError] = useState<string | null>(null)

  const resolveUrl = useCallback(
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

  const saveImage = useCallback(
    async (file: File): Promise<string | null> => {
      const extension = EXTENSION_BY_MIME[file.type]
      if (!extension || generation === null) {
        return null
      }
      // Timestamp + random suffix: two pastes can land in the same millisecond
      // (e.g. a multi-file drop), and a bare Date.now() name would collide.
      const target = assetPath(
        `pasted-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`,
      )
      await writeAsset(target, base64Of(await file.arrayBuffer()), generation)
      setSaveError(null)
      return target
    },
    [generation],
  )

  const onSaveError = useCallback((error: unknown) => {
    setSaveError(errorMessage(error))
  }, [])

  const options = useMemo<ImageOptions>(
    () => ({ resolveUrl, saveImage, onSaveError }),
    [resolveUrl, saveImage, onSaveError],
  )

  return useMemo<ImagePersistence>(() => ({ options, saveError }), [options, saveError])
}
