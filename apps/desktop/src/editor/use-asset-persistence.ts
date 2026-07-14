import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  FileInfo,
  FileLinkPayload,
  FileLinkResolver,
  WikiEmbedResolver,
} from '@meowdown/core'
import {
  attachmentRenderKind,
  assetFileName,
  createAsset,
  errorMessage,
  indexWikiNoteReference,
  listDir,
  openAsset as openAssetCommand,
  resolveAttachment,
  type FileMeta,
} from '@reflect/core'
import { formatBytes } from '@/lib/format-bytes'
import { attachmentDisplayUrl } from '@/lib/attachment-display-url'
import { startOperation } from '@/lib/operations'
import { useAttachmentCatalog } from '@/providers/attachment-catalog-provider'

/**
 * Above this size, a save gets a non-blocking status-line warning. Never a
 * wall (it's the user's disk), and not a modal either — the drop already
 * said what the user wants — but git backup is the quiet constraint: every
 * binary lives in history forever, and GitHub hard-rejects files over
 * 100 MB, so the size is worth a mention.
 */
export const LARGE_FILE_BYTES = 25 * 1024 * 1024
const MATERIALIZATION_RETRY_MS = 10_000

/** Asset file extension for each image MIME type that gets `pasted-…` naming. */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
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
  return isSafeAssetSource(href) && attachmentRenderKind(href) !== null
}

/**
 * Render the canonical `targetPath` as a Markdown href relative to the note
 * that received a paste. Reflect keeps new files in `assets/`, but nested
 * adopted notes must not receive a path that accidentally points into their
 * own directory.
 */
export function relativeAttachmentHref(sourcePath: string, targetPath: string): string {
  const source = sourcePath.split('/')
  source.pop()
  const target = targetPath.split('/')
  let shared = 0
  while (shared < source.length && shared < target.length && source[shared] === target[shared]) {
    shared += 1
  }
  return `${'../'.repeat(source.length - shared)}${target.slice(shared).join('/')}`
}

/** Encode a canonical graph path back into an explicit authored root reference. */
export function vaultAttachmentReference(path: string): string {
  return `/${path.split('/').map(encodeURIComponent).join('/')}`
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
  /** Resolve an image authored by an explicitly identified source note. */
  resolveImageUrlFromSource: (sourcePath: string, src: string) => string | null
  /** Vet a source as a graph-relative asset path for {@link openAsset} (null for remote/unsafe). */
  resolveAssetOpenPath: (src: string) => string | null
  /** Resolve an openable attachment authored by an explicitly identified source note. */
  resolveAssetOpenPathFromSource: (sourcePath: string, src: string) => string | null
  /** Claim resolved local Markdown attachment links as file pills. */
  resolveFileLink: FileLinkResolver
  /** Classify Obsidian wiki embeds through the current attachment catalog. */
  resolveWikiEmbed: WikiEmbedResolver
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
  /** Changes when external attachment arrivals/removals require a reparse. */
  attachmentCatalogRevision: number
  /** The most recent failed save; cleared by the next success. */
  saveError: AssetSaveError | null
}

/**
 * Asset handling for one open graph: resolve `![…](…)` sources to displayable
 * URLs (remote URLs pass through; `assets/` paths map to `reflect-asset://`
 * URLs served off the UI thread by the Rust shell), open asset links in the
 * OS viewer, and persist pasted/dropped files by streaming them into the
 * graph's `assets/` folder — Rust resolves `-2`-style name collisions at
 * write time. A save over {@link LARGE_FILE_BYTES} gets a non-blocking
 * status-line warning after it lands. `generation` pins every save — and
 * every image URL — to the issuing graph session, so a save or image load
 * racing a graph switch is rejected loudly instead of landing in (or reading
 * from) the wrong graph; `path`, when given, scopes the error banner to the
 * note being edited (a pane is reused across note switches).
 */
export function useAssetPersistence(
  generation: number | null,
  path?: string,
): AssetPersistence {
  const attachmentCatalog = useAttachmentCatalog()
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
  const locallySavedPaths = useRef(new Map<string, string>())
  const requestedMaterializations = useRef(new Map<string, number>())

  useEffect(() => {
    return () => {
      sessionEpoch.current += 1
      setSaveError(null)
      // Authored hrefs and materialization requests are source-relative. A
      // pane can keep its editor mounted through a managed move, so neither
      // cache may survive a source-path change.
      locallySavedPaths.current = new Map()
      requestedMaterializations.current = new Map()
    }
  }, [path, generation])

  useEffect(() => {
    return () => {
      // Replace the map rather than clearing it: a listing or save still in
      // flight for the old graph session writes into the orphaned instance,
      // never into the next session's cache.
      sizeByAssetPath.current = new Map()
      pendingAssetListing.current = null
      locallySavedPaths.current = new Map()
      requestedMaterializations.current = new Map()
    }
  }, [generation])

  const attachmentCatalogRevision = attachmentCatalog?.revision ?? 0
  useEffect(() => {
    // A manifest transition may be a completed download or a later eviction.
    // Either way, the new state gets a fresh materialization attempt.
    requestedMaterializations.current = new Map()
  }, [attachmentCatalogRevision])

  const sourcePath = path ?? 'README.md'

  const resolvedAttachment = useCallback(
    (
      authoredSourcePath: string,
      reference: string,
      referenceKind: 'markdown' | 'wikiEmbed',
    ): { path: string; renderKind: 'image' | 'file'; unavailable: boolean } | null => {
      const locallySaved =
        referenceKind === 'markdown' && authoredSourcePath === sourcePath
          ? locallySavedPaths.current.get(reference)
          : undefined
      if (locallySaved !== undefined) {
        const renderKind = attachmentRenderKind(locallySaved)
        return renderKind === null ? null : { path: locallySaved, renderKind, unavailable: false }
      }
      if (attachmentCatalog === null) {
        if (referenceKind !== 'markdown' || !isSafeAssetSource(reference)) {
          return null
        }
        const renderKind = attachmentRenderKind(reference)
        return renderKind === null ? null : { path: reference, renderKind, unavailable: false }
      }
      const outcome = attachmentCatalog.resolve({
        sourcePath: authoredSourcePath,
        reference,
        referenceKind,
      })
      if (outcome.kind === 'resolved') {
        return { path: outcome.path, renderKind: outcome.renderKind, unavailable: false }
      }
      if (outcome.kind === 'unavailable') {
        const renderKind = attachmentRenderKind(outcome.path)
        return renderKind === null
          ? null
          : { path: outcome.path, renderKind, unavailable: true }
      }
      return null
    },
    [attachmentCatalog, sourcePath],
  )

  const requestMaterialization = useCallback(
    (
      authoredSourcePath: string,
      reference: string,
      referenceKind: 'markdown' | 'wikiEmbed',
      canonicalPath: string,
    ): void => {
      const now = Date.now()
      const lastRequest = requestedMaterializations.current.get(canonicalPath)
      if (
        generation === null ||
        (lastRequest !== undefined && now - lastRequest < MATERIALIZATION_RETRY_MS)
      ) {
        return
      }
      requestedMaterializations.current.set(canonicalPath, now)
      void resolveAttachment({
        sourcePath: authoredSourcePath,
        reference,
        referenceKind,
        generation,
      }).catch(() => {
        requestedMaterializations.current.delete(canonicalPath)
      })
    },
    [generation],
  )

  const resolveImageUrlFromSource = useCallback(
    (authoredSourcePath: string, src: string): string | null => {
      if (/^https?:\/\//.test(src)) {
        return src
      }
      if (generation !== null) {
        const resolved = resolvedAttachment(authoredSourcePath, src, 'markdown')
        if (resolved?.renderKind === 'image') {
          if (resolved.unavailable) {
            requestMaterialization(authoredSourcePath, src, 'markdown', resolved.path)
          }
          return attachmentDisplayUrl(generation, resolved.path, attachmentCatalogRevision)
        }
      }
      return null
    },
    [attachmentCatalogRevision, generation, requestMaterialization, resolvedAttachment],
  )

  const resolveImageUrl = useCallback(
    (src: string): string | null => resolveImageUrlFromSource(sourcePath, src),
    [resolveImageUrlFromSource, sourcePath],
  )

  const resolveAssetOpenPathFromSource = useCallback(
    (authoredSourcePath: string, src: string): string | null => {
      if (generation !== null) {
        return resolvedAttachment(authoredSourcePath, src, 'markdown')?.path ?? null
      }
      return null
    },
    [generation, resolvedAttachment],
  )

  const resolveAssetOpenPath = useCallback(
    (src: string): string | null => resolveAssetOpenPathFromSource(sourcePath, src),
    [resolveAssetOpenPathFromSource, sourcePath],
  )

  const resolveFileLink = useCallback<FileLinkResolver>(
    ({ href }) => resolvedAttachment(sourcePath, href, 'markdown') !== null,
    [resolvedAttachment, sourcePath],
  )

  const resolveWikiEmbed = useCallback<WikiEmbedResolver>(
    ({ target, display }) => {
      const outcome = attachmentCatalog?.resolve({
        sourcePath,
        reference: target,
        referenceKind: 'wikiEmbed',
      })
      if (outcome?.kind === 'resolved' || outcome?.kind === 'unavailable') {
        const renderKind =
          outcome.kind === 'resolved' ? outcome.renderKind : attachmentRenderKind(outcome.path)
        if (renderKind === null) {
          return undefined
        }
        const explicitRootPath = vaultAttachmentReference(outcome.path)
        return renderKind === 'image'
          ? { kind: 'image', src: explicitRootPath, ...(display === '' ? {} : { alt: display }) }
          : {
              kind: 'file',
              href: explicitRootPath,
              ...(display === '' ? {} : { name: display }),
            }
      }

      // Extensionless and `.md` embeds fall back to a navigable note chip;
      // supported-but-missing/ambiguous attachments stay literal because the
      // catalog resolver returned `notFound`/`ambiguous`, not `invalid`.
      if (outcome !== undefined && outcome.kind !== 'invalid') {
        return undefined
      }
      const withoutFragment = target.split('#', 1)[0] ?? target
      const fileName = withoutFragment.split('/').at(-1) ?? withoutFragment
      const separator = fileName.lastIndexOf('.')
      const noteLike = separator <= 0 || fileName.slice(separator).toLowerCase() === '.md'
      return noteLike && indexWikiNoteReference(sourcePath, target) !== null
        ? { kind: 'note' }
        : undefined
    },
    [attachmentCatalog, sourcePath],
  )

  const openAsset = useCallback(
    async (assetPath: string): Promise<void> => {
      if (generation === null) {
        return
      }
      const outcome = await resolveAttachment({
        sourcePath,
        reference: vaultAttachmentReference(assetPath),
        referenceKind: 'markdown',
        generation,
      })
      if (outcome.kind === 'unavailable') {
        startOperation('Opening attachment').warn(
          'This attachment is downloading from iCloud. Try opening it again in a moment.',
        )
        return
      }
      if (outcome.kind !== 'resolved') {
        throw new Error(`attachment is no longer available: ${assetPath}`)
      }
      await openAssetCommand(outcome.path, generation)
    },
    [generation, sourcePath],
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
      if (attachmentRenderKind(`assets/${desiredName}`) === null) {
        if (!isStale()) {
          setSaveError({
            kind: file.type.startsWith('image/') ? 'image' : 'file',
            message:
              'Unsupported attachment format. Reflect accepts Obsidian-compatible images, audio, video, and PDF files.',
          })
        }
        return null
      }
      // Captured before the await: a save resolving after a graph switch
      // seeds the orphaned session's cache, not the next graph's.
      const sizeCache = sizeByAssetPath.current
      try {
        const saved = await createAsset(desiredName, file, generation)
        sizeCache.set(saved, file.size)
        // The asset exists, but the editor that requested it may now represent
        // another path. Declining insertion is the only safe choice: computing
        // an href from the old source would create a broken relative link.
        if (isStale()) {
          return null
        }
        const href = relativeAttachmentHref(sourcePath, saved)
        locallySavedPaths.current.set(href, saved)
        if (file.size > LARGE_FILE_BYTES) {
          startOperation('Large file added').warn(
            `“${file.name}” is ${formatBytes(file.size)}. Git keeps every version forever; GitHub rejects files over 100 MB.`,
          )
        }
        setSaveError(null)
        return href
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
    [generation, sourcePath],
  )

  const resolveFileInfo = useCallback(
    async (href: string): Promise<FileInfo | undefined> => {
      if (generation === null) {
        return undefined
      }
      const resolved = resolvedAttachment(sourcePath, href, 'markdown')
      if (resolved === null || resolved.unavailable) {
        return undefined
      }
      // Captured before the await for the same session-scoping reason as in
      // saveFile.
      const cache = sizeByAssetPath.current
      if (attachmentCatalog !== null) {
        const file = attachmentCatalog.metadataForPath(resolved.path)
        if (file !== undefined && file.placeholder !== true) {
          return { size: file.size }
        }
      }
      if (!cache.has(resolved.path) && attachmentCatalog === null) {
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
      const size = cache.get(resolved.path)
      return size === undefined ? undefined : { size }
    },
    [attachmentCatalog, generation, resolvedAttachment, sourcePath],
  )

  return useMemo<AssetPersistence>(
    () => ({
      resolveImageUrl,
      resolveImageUrlFromSource,
      resolveAssetOpenPath,
      resolveAssetOpenPathFromSource,
      resolveFileLink,
      resolveWikiEmbed,
      openAsset,
      saveFile,
      resolveFileInfo,
      attachmentCatalogRevision,
      saveError,
    }),
    [
      attachmentCatalogRevision,
      openAsset,
      resolveAssetOpenPath,
      resolveAssetOpenPathFromSource,
      resolveFileInfo,
      resolveFileLink,
      resolveImageUrl,
      resolveImageUrlFromSource,
      resolveWikiEmbed,
      saveError,
      saveFile,
    ],
  )
}
