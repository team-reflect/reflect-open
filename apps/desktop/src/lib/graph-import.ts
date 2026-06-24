import type { ImportFile } from '@reflect/core'
import { base64Of } from '@/lib/base64'

/**
 * Reading a dropped Reflect V1 export off a {@link DataTransfer}.
 *
 * A V1 "Reflect Open folder" export is already V2's markdown graph shape, so an
 * import is a copy, not a transform. The web layer never sees a dropped folder's
 * real filesystem path (WebKit hides it), so we ship the *contents* to Rust:
 * the raw bytes of a dropped `.zip`, or — for a dropped directory — its files
 * enumerated via WebKit's entry API. Rust materializes either into a new graph.
 *
 * The pure predicates here ({@link isZipFileName}, {@link shouldSkipImportEntry},
 * {@link looksLikeGraphPaths}) mirror Rust's own rules so the UI can classify
 * and pre-validate a drop without a round-trip; Rust re-validates for real.
 */

/** Top-level directories an import must never copy (rebuildable / VCS). */
const SKIP_TOP_LEVEL = new Set(['.reflect', '.git'])

/** Whether `name` looks like a zip archive (by extension). */
export function isZipFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.zip')
}

/**
 * Whether an archive-relative path should be skipped during import: the
 * rebuildable `.reflect/` index, VCS metadata, and OS/editor junk. Skipping
 * these in the browser also avoids reading bytes Rust would only discard.
 */
export function shouldSkipImportEntry(relPath: string): boolean {
  const parts = relPath.split('/').filter(Boolean)
  if (parts.length === 0) {
    return true
  }
  if (SKIP_TOP_LEVEL.has(parts[0]!)) {
    return true
  }
  const name = parts[parts.length - 1]!
  return name === '.DS_Store' || name === 'Thumbs.db' || name.endsWith('.swp')
}

/**
 * A quick "is this a Reflect graph?" check: does any path point at a markdown
 * note under `daily/` or `notes/` (allowing a single wrapping folder)? Lets the
 * UI reject a stray folder before uploading every file; Rust validates for real.
 */
export function looksLikeGraphPaths(relPaths: readonly string[]): boolean {
  return relPaths.some((path) => /(?:^|\/)(?:daily|notes)\/.+\.md$/i.test(path))
}

/** What a drop on the chooser turned out to be. */
export type DroppedImport =
  | { kind: 'folder'; name: string; entry: FileSystemDirectoryEntry }
  | { kind: 'zip'; name: string; file: File }
  | { kind: 'none' }

/**
 * Classify a drop as a folder, a `.zip`, or neither. Must be called
 * synchronously inside the drop handler — a {@link DataTransfer}'s items are
 * cleared once the event returns (the captured `entry`/`file` stay valid).
 * Prefers WebKit's entry API (the only way to see a dropped *directory*) and
 * falls back to the file list for the zip case.
 */
export function classifyDrop(transfer: DataTransfer): DroppedImport {
  const fileItem = Array.from(transfer.items).find((item) => item.kind === 'file')
  const entry = fileItem?.webkitGetAsEntry?.() ?? null
  if (entry && isDirectoryEntry(entry)) {
    return { kind: 'folder', name: entry.name, entry }
  }
  const zip = Array.from(transfer.files).find((file) => isZipFileName(file.name))
  if (zip) {
    return { kind: 'zip', name: zip.name, file: zip }
  }
  return { kind: 'none' }
}

/** A file discovered under a dropped folder, paired with its (unread) entry. */
export interface FolderFile {
  /** Path relative to the dropped folder, forward-slashed. */
  path: string
  entry: FileSystemFileEntry
}

/**
 * Enumerate every file under a dropped directory — paths only, **no bytes read**
 * — skipping cruft ({@link shouldSkipImportEntry}). Splitting discovery from
 * reading lets the caller validate the paths ({@link looksLikeGraphPaths}) and
 * bail on a non-export folder before pulling any file into memory. WebKit's
 * directory reader returns entries in batches, so each directory is drained
 * until `readEntries` yields nothing.
 */
export async function collectFolderFiles(root: FileSystemDirectoryEntry): Promise<FolderFile[]> {
  const files: FolderFile[] = []
  const walk = async (dir: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    for (const entry of await readAllEntries(dir)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (shouldSkipImportEntry(path)) {
        continue
      }
      if (isDirectoryEntry(entry)) {
        await walk(entry, path)
      } else if (isFileEntry(entry)) {
        files.push({ path, entry })
      }
    }
  }
  await walk(root, '')
  return files
}

/** Read one enumerated folder file into an {@link ImportFile} (bytes inlined). */
export async function readFolderFile(file: FolderFile): Promise<ImportFile> {
  const data = await entryToFile(file.entry)
  return { path: file.path, contentsBase64: base64Of(await data.arrayBuffer()) }
}

/** Read a dropped `.zip` file into its base64 payload for the JSON IPC. */
export async function zipFileToBase64(file: File): Promise<string> {
  return base64Of(await file.arrayBuffer())
}

function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile
}

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const readNext = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        readNext()
      }, reject)
    }
    readNext()
  })
}

function entryToFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}
