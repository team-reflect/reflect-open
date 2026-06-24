import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { errorMessage, importGraphFiles, importGraphZip, type ImportFile } from '@reflect/core'
import {
  classifyDrop,
  collectFolderFiles,
  looksLikeGraphPaths,
  readFolderFile,
  zipFileToBase64,
  type DroppedImport,
} from '@/lib/graph-import'
import { useGraph } from '@/providers/graph-provider'

const NOT_A_GRAPH =
  'That doesn’t look like a Reflect export. Drop the folder (or .zip) you exported from Reflect V1.'

/** Drag handlers to spread onto the chooser's drop zone. */
export interface GraphDropHandlers {
  onDragEnter: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
}

/**
 * How long after the last `dragover` to assume the drag has left and hide the
 * overlay. `dragover` fires repeatedly (~every 350ms) while a drag is over the
 * window, even when stationary, so a window comfortably above that interval
 * keeps the overlay up for the whole drag without per-element bookkeeping.
 */
const DRAG_IDLE_MS = 700

/** State + handlers for dropping a Reflect V1 export onto the chooser. */
export interface GraphImport {
  /** True while a drag carrying files hovers the drop zone (show the overlay). */
  isDragging: boolean
  /** True while a dropped export is materializing and opening. */
  importing: boolean
  /** A human-readable import failure, or null. */
  importError: string | null
  /** Clear a lingering import error so a later open/picker error isn't masked. */
  clearImportError: () => void
  handlers: GraphDropHandlers
}

/** Whether a drag is carrying files (vs. selected text, a link, etc.). */
function carriesFiles(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes('Files')
}

/**
 * Drag-and-drop import of a Reflect V1 export onto the graph chooser. A dropped
 * `.zip` or folder is read in the browser, shipped to Rust to materialize as a
 * new graph under `~/Documents/Reflect/`, then opened through the normal flow.
 *
 * Folders can't be opened in place — WebKit never exposes a dropped directory's
 * real path — so they are copied; a `.zip` is extracted. See {@link useGraph}
 * for the open flow the returned graph path feeds into.
 */
export function useGraphImport(): GraphImport {
  const { openRecent } = useGraph()
  const [isDragging, setIsDragging] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  // Heartbeat timer: each `dragover` re-arms it, and it hides the overlay once
  // the events stop (the drag left or dropped). This avoids the brittle
  // dragenter/dragleave depth counting that misfires in WebKit when the pointer
  // crosses onto child elements.
  const dragIdle = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Mirror `importing` for the synchronous drop guard (state would be stale).
  const busy = useRef(false)

  const clearImportError = useCallback((): void => setImportError(null), [])

  // Show the overlay and (re-)arm the idle timer that hides it.
  const markDragging = useCallback((): void => {
    setIsDragging(true)
    if (dragIdle.current !== null) {
      clearTimeout(dragIdle.current)
    }
    dragIdle.current = setTimeout(() => setIsDragging(false), DRAG_IDLE_MS)
  }, [])

  // Drop the idle timer on unmount so it can't set state on a gone component.
  useEffect(() => {
    return () => {
      if (dragIdle.current !== null) {
        clearTimeout(dragIdle.current)
      }
    }
  }, [])

  const runImport = useCallback(
    async (dropped: DroppedImport): Promise<void> => {
      if (dropped.kind === 'none') {
        setImportError(NOT_A_GRAPH)
        return
      }
      busy.current = true
      setImporting(true)
      setImportError(null)
      try {
        let root: string
        if (dropped.kind === 'zip') {
          root = await importGraphZip(dropped.name, await zipFileToBase64(dropped.file))
        } else {
          // Validate the folder's paths before reading any bytes, so a non-export
          // directory is rejected without pulling its files into memory.
          const folderFiles = await collectFolderFiles(dropped.entry)
          if (!looksLikeGraphPaths(folderFiles.map((file) => file.path))) {
            setImportError(NOT_A_GRAPH)
            return
          }
          const files: ImportFile[] = []
          for (const folderFile of folderFiles) {
            files.push(await readFolderFile(folderFile))
          }
          root = await importGraphFiles(dropped.name, files)
        }
        await openRecent(root)
      } catch (error) {
        setImportError(errorMessage(error))
      } finally {
        busy.current = false
        setImporting(false)
      }
    },
    [openRecent],
  )

  const onDragEnter = useCallback(
    (event: DragEvent): void => {
      if (!carriesFiles(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      markDragging()
    },
    [markDragging],
  )

  const onDragOver = useCallback(
    (event: DragEvent): void => {
      if (!carriesFiles(event.dataTransfer)) {
        return
      }
      event.preventDefault() // permit the drop
      markDragging()
    },
    [markDragging],
  )

  const onDrop = useCallback(
    (event: DragEvent): void => {
      if (!carriesFiles(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      if (dragIdle.current !== null) {
        clearTimeout(dragIdle.current)
        dragIdle.current = null
      }
      setIsDragging(false)
      if (busy.current) {
        return // already importing — ignore a second drop
      }
      // Capture the drop synchronously: the DataTransfer is emptied once this
      // handler returns, though the resolved entry/file stay readable.
      void runImport(classifyDrop(event.dataTransfer))
    },
    [runImport],
  )

  return {
    isDragging,
    importing,
    importError,
    clearImportError,
    handlers: { onDragEnter, onDragOver, onDrop },
  }
}
