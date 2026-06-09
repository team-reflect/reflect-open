import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { isAppError, readNote, subscribeFileChanges, writeNote } from '@reflect/core'
import type { NoteEditorHandle } from './note-editor'
import { checkRoundTrip } from './roundtrip'

/**
 * The save pipeline + external-change reconciliation for one open note
 * (Plan 05 steps 4–5).
 *
 * Saves are debounced atomic writes (Plan 02); indexing is **not** triggered
 * here — the watcher is the sole incremental-reindex path (Plan 04b), so our own
 * write flows file → watcher → index like any other change. The same watcher
 * event comes back to us; we recognize the echo by content (it matches what we
 * last saved) and ignore it. A real external change reloads a clean buffer
 * imperatively, and **never clobbers a dirty one** — it parks as `conflict` for
 * the user to resolve.
 */

const SAVE_DEBOUNCE_MS = 800

export type NoteDocumentStatus = 'loading' | 'ready' | 'error'

export interface NoteDocument {
  status: NoteDocumentStatus
  /** Markdown to seed the editor with once `status` is `ready`. */
  initialContent: string
  /**
   * True when the editor cannot faithfully round-trip this note (a converter
   * gap, e.g. task lists today) — the note opens read-only and is **never**
   * auto-rewritten, so no content can be silently lost.
   */
  protected: boolean
  /** True while the buffer has changes not yet written to disk. */
  dirty: boolean
  /** External content waiting on the user's choice (set only when dirty). */
  conflict: string | null
  error: string | null
  /** Wire to the editor: every document change enters the pipeline here. */
  onEditorChange: (markdown: string) => void
  /** Wire to the editor's imperative handle (reload/conflict application). */
  bindEditor: (handle: NoteEditorHandle | null) => void
  /** Resolve a conflict by keeping the buffer (rewrites the file). */
  keepMine: () => void
  /** Resolve a conflict by loading the external content (discards the buffer). */
  loadTheirs: () => void
}

export function useNoteDocument(path: string | null): NoteDocument {
  const [status, setStatus] = useState<NoteDocumentStatus>('loading')
  const [initialContent, setInitialContent] = useState('')
  const [isProtected, setIsProtected] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const editorRef = useRef<NoteEditorHandle | null>(null)
  /** The buffer as of the last editor change. */
  const bufferRef = useRef('')
  /** The content most recently read from or written to disk. */
  const diskRef = useRef('')
  const dirtyRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Serializes writes so a flush can't interleave with a debounced save. */
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  /**
   * Content of the write currently in flight (set when dispatched, before the
   * IPC resolves). The watcher event for our own save can arrive before
   * `writeNote` settles and `diskRef` updates — matching against this prevents
   * a false conflict when the user kept typing during the save.
   */
  const inFlightWriteRef = useRef<string | null>(null)
  /** Mirrors `conflict` so the save pipeline can pause without re-rendering. */
  const conflictRef = useRef<string | null>(null)
  /**
   * The currently-open path, updated synchronously on render — guards a write
   * started for the previous note from mutating the new note's tracking refs.
   */
  const pathRef = useRef(path)
  pathRef.current = path

  const markClean = useCallback((content: string, forPath: string) => {
    if (pathRef.current !== forPath) {
      return // a stale save for the previous note must not touch the new one
    }
    diskRef.current = content
    dirtyRef.current = bufferRef.current !== content
    setDirty(dirtyRef.current)
  }, [])

  /** Mirrors the `protected` state for non-reactive checks in the pipeline. */
  const protectedRef = useRef(false)

  const save = useCallback(() => {
    // A parked conflict pauses all saves: writing the buffer before the user
    // chooses Keep mine / Load theirs would clobber the external change and
    // defeat the non-destructive flow.
    if (!path || !dirtyRef.current || protectedRef.current || conflictRef.current !== null) {
      return
    }
    const savedPath = path
    const content = bufferRef.current
    saveChain.current = saveChain.current
      .then(() => {
        inFlightWriteRef.current = content
        return writeNote(savedPath, content)
      })
      .then(() => markClean(content, savedPath))
      .catch((err) => {
        setError(messageOf(err))
      })
      .finally(() => {
        inFlightWriteRef.current = null
      })
  }, [path, markClean])

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
    }
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      save()
    }, SAVE_DEBOUNCE_MS)
  }, [save])

  const flush = useCallback(() => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    save()
  }, [save])

  const onEditorChange = useCallback(
    (markdown: string) => {
      bufferRef.current = markdown
      dirtyRef.current = markdown !== diskRef.current
      setDirty(dirtyRef.current)
      if (dirtyRef.current) {
        scheduleSave()
      }
    },
    [scheduleSave],
  )

  const bindEditor = useCallback((handle: NoteEditorHandle | null) => {
    editorRef.current = handle
  }, [])

  /** True while the path-load effect's read is in flight. */
  const loadingRef = useRef(false)
  /** A watcher event arrived during the load; replay reconciliation after it. */
  const missedChangeRef = useRef(false)

  /**
   * Re-read the note and reconcile the buffer with what's on disk (the
   * external-change path). Guarded by `pathRef`, so a slow read can't apply
   * across a note switch.
   */
  const reconcileFromDisk = useCallback(
    async (forPath: string): Promise<void> => {
      let content: string
      try {
        content = await readNote(forPath)
      } catch {
        return // deleted/unreadable between event and read; nothing to reconcile
      }
      if (
        pathRef.current !== forPath ||
        content === diskRef.current ||
        content === inFlightWriteRef.current
      ) {
        return // stale, or an echo of our own (possibly still-settling) save
      }
      if (dirtyRef.current) {
        // Never clobber unsaved edits — park the external content and pause
        // the save pipeline (cancel any pending debounce) until the user
        // chooses; a save landing now would overwrite "theirs" first.
        if (saveTimer.current !== null) {
          clearTimeout(saveTimer.current)
          saveTimer.current = null
        }
        conflictRef.current = content
        setConflict(content)
        return
      }
      bufferRef.current = content
      markClean(content, forPath)
      // Re-gate: the external edit may have introduced (or removed) syntax the
      // editor can't round-trip. Remount via initialContent when protection
      // flips; otherwise reload the live editor in place.
      const lossy = checkRoundTrip(content) === 'lossy'
      if (lossy !== protectedRef.current) {
        protectedRef.current = lossy
        setIsProtected(lossy)
        setInitialContent(content)
        return
      }
      setInitialContent(content)
      // While protected there is no live editor mounted (the pane shows the
      // read-only view), and lossy content must never enter one regardless.
      if (!lossy) {
        editorRef.current?.setMarkdown(content)
      }
    },
    [markClean],
  )

  // Load the note when the path changes.
  useEffect(() => {
    if (!path) {
      return
    }
    let active = true
    setStatus('loading')
    conflictRef.current = null
    setConflict(null)
    setError(null)
    loadingRef.current = true
    missedChangeRef.current = false
    void (async () => {
      try {
        const content = await readNote(path)
        if (!active) {
          return
        }
        bufferRef.current = content
        diskRef.current = content
        dirtyRef.current = false
        // The data-loss gate: a note the editor can't reproduce opens read-only.
        protectedRef.current = checkRoundTrip(content) === 'lossy'
        setIsProtected(protectedRef.current)
        setDirty(false)
        setInitialContent(content)
        setStatus('ready')
      } catch (err) {
        if (active) {
          setError(messageOf(err))
          setStatus('error')
        }
      } finally {
        if (active) {
          loadingRef.current = false
          // A change event during the load was deferred (reconciling mid-load
          // could be overwritten by this load's older read committing later);
          // replay it now against the committed state.
          if (missedChangeRef.current) {
            missedChangeRef.current = false
            void reconcileFromDisk(path)
          }
        }
      }
    })()
    return () => {
      active = false
    }
  }, [path, reconcileFromDisk])

  // External-change reconciliation via the watcher (Plan 04b events).
  useEffect(() => {
    if (!path || !isTauri()) {
      return
    }
    let active = true
    let unlisten: (() => void) | null = null
    void subscribeFileChanges((changes) => {
      if (!active || !changes.some((change) => change.path === path && change.kind === 'upsert')) {
        return
      }
      if (loadingRef.current) {
        missedChangeRef.current = true // deferred; replayed when the load commits
        return
      }
      void reconcileFromDisk(path)
    }).then((fn) => {
      if (active) {
        unlisten = fn
      } else {
        fn()
      }
    })
    return () => {
      active = false
      unlisten?.()
    }
  }, [path, reconcileFromDisk])

  // Flush pending edits on blur and on unmount/path change.
  useEffect(() => {
    if (!path) {
      return
    }
    window.addEventListener('blur', flush)
    return () => {
      window.removeEventListener('blur', flush)
      flush()
    }
  }, [path, flush])

  const keepMine = useCallback(() => {
    conflictRef.current = null
    setConflict(null)
    dirtyRef.current = true // force the rewrite even if content drifted equal
    save()
  }, [save])

  const loadTheirs = useCallback(() => {
    if (conflict === null || path === null) {
      return
    }
    conflictRef.current = null
    bufferRef.current = conflict
    markClean(conflict, path)
    // Same re-gating as the clean-reload path: never load lossy content into a
    // live editor whose next save would drop what it can't model.
    const lossy = checkRoundTrip(conflict) === 'lossy'
    protectedRef.current = lossy
    setIsProtected(lossy)
    setInitialContent(conflict)
    if (!lossy) {
      editorRef.current?.setMarkdown(conflict)
    }
    setConflict(null)
  }, [conflict, markClean])

  return {
    status,
    initialContent,
    protected: isProtected,
    dirty,
    conflict,
    error,
    onEditorChange,
    bindEditor,
    keepMine,
    loadTheirs,
  }
}

function messageOf(error: unknown): string {
  if (isAppError(error)) {
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}
