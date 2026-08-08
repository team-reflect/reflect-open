import { useCallback, useEffect, useRef, useState } from 'react'
import { readAnnotations, writeAnnotations } from '@reflect/core'
import { z } from 'zod'

/**
 * The PDF annotation model (one per graph-relative `assets/…pdf` file) and
 * its React store. The sidecar JSON shape is owned by the PDF-annotation
 * lane — `parseAnnotationFile` is the one place the frontend reads it, so a
 * schema tightening never leaks anywhere else. Reads surface the sidecar as
 * `'loading' | 'ready' | 'error'`; mutations apply to local state immediately
 * and persist through a debounced, last-write-wins `writeAnnotations` call.
 */

export interface AnnotationItem {
  id: string
  /** The 0-based page the annotation lives on. */
  pageIndex: number
  type: 'text' | 'border'
  /** Normalized (0–1) rectangles as `[x1, y1, x2, y2]` tuples. */
  rects: number[][]
  color: string
  text: string
}

export interface AnnotationFile {
  version: number
  path: string
  annotations: AnnotationItem[]
}

const rectSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

const annotationItemSchema = z.object({
  id: z.string(),
  pageIndex: z.number().int().nonnegative(),
  type: z.enum(['text', 'border']),
  rects: z.array(rectSchema),
  color: z.string(),
  text: z.string(),
})

const annotationFileSchema = z.object({
  version: z.literal(1),
  path: z.string(),
  annotations: z.array(annotationItemSchema),
})

/**
 * Parse the sidecar JSON text into an {@link AnnotationFile}, or null for
 * anything that isn't one: an empty string (the Rust read's "nothing cached
 * yet" answer), malformed JSON, or a payload that doesn't match the schema.
 * Never throws.
 */
export function parseAnnotationFile(json: string): AnnotationFile | null {
  if (json.trim() === '') {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const result = annotationFileSchema.safeParse(parsed)
  return result.success ? result.data : null
}

export type PdfAnnotationsStatus = 'loading' | 'ready' | 'error'

export interface UsePdfAnnotationsResult {
  annotations: AnnotationItem[]
  status: PdfAnnotationsStatus
  addAnnotation: (annotation: Omit<AnnotationItem, 'id'>) => void
  updateAnnotation: (id: string, patch: Partial<Omit<AnnotationItem, 'id'>>) => void
  removeAnnotation: (id: string) => void
}

/** Debounce window between the last edit and the sidecar write. */
export const ANNOTATION_WRITE_DEBOUNCE_MS = 500

/** Pending debounced write: the timer plus the (path, generation) it was scheduled for. */
interface PendingWrite {
  timer: ReturnType<typeof setTimeout>
  path: string
}

/**
 * The annotation store for one PDF: load its sidecar on (path, generation)
 * change and persist edits through a debounced, last-write-wins
 * `writeAnnotations`. `generation` is the open graph session's — the sidecar
 * commands resolve against the *current* graph, so the hook gates on it and
 * resets (flushing any pending edit first) when it or the path changes,
 * following `use-asset-persistence`'s session-scoping convention.
 */
export function usePdfAnnotations(
  pdfPath: string,
  generation: number | null,
): UsePdfAnnotationsResult {
  const [annotations, setAnnotations] = useState<AnnotationItem[]>([])
  const [status, setStatus] = useState<PdfAnnotationsStatus>('loading')
  // Read at fire time, not schedule time: the timer and the load guard must
  // write for the PDF (and graph session) they now represent, and reopening
  // the same graph bumps the generation without remounting the consumer.
  const pathRef = useRef(pdfPath)
  // eslint-disable-next-line react-hooks/refs
  pathRef.current = pdfPath
  const generationRef = useRef(generation)
  // eslint-disable-next-line react-hooks/refs
  generationRef.current = generation
  const annotationsRef = useRef(annotations)
  // eslint-disable-next-line react-hooks/refs
  annotationsRef.current = annotations
  const pendingRef = useRef<PendingWrite | null>(null)

  const persist = useCallback((path: string, content: string): void => {
    void writeAnnotations(path, content).catch((cause: unknown) => {
      console.error('write annotations failed:', cause)
    })
  }, [])

  const scheduleWrite = useCallback((): void => {
    const path = pathRef.current
    if (generationRef.current === null) {
      return
    }
    if (pendingRef.current !== null) {
      clearTimeout(pendingRef.current.timer)
    }
    pendingRef.current = {
      path,
      timer: setTimeout(() => {
        pendingRef.current = null
        // Merge the local state at fire time — every edit since the timer was
        // scheduled lands in this one write (last-write-wins by construction).
        const file: AnnotationFile = {
          version: 1,
          path,
          annotations: annotationsRef.current,
        }
        persist(path, JSON.stringify(file))
      }, ANNOTATION_WRITE_DEBOUNCE_MS),
    }
  }, [persist])

  // Reset to the loading state whenever the (path, generation) key changes.
  // This is the "adjusting state when a prop changes" pattern applied during
  // render, so the panel never flashes the previous PDF's annotations and no
  // effect-reset round-trip is needed.
  const [loadedKey, setLoadedKey] = useState<[string, number | null]>([pdfPath, generation])
  if (loadedKey[0] !== pdfPath || loadedKey[1] !== generation) {
    setLoadedKey([pdfPath, generation])
    setAnnotations([])
    setStatus('loading')
  }

  // Load the sidecar; the (path, generation) key re-runs it on a PDF switch
  // or graph-session change, tearing down any in-flight read from the old one.
  useEffect(() => {
    let active = true
    if (generation === null) {
      return () => {
        active = false
      }
    }
    void readAnnotations(pdfPath)
      .then((json) => {
        if (!active) {
          return
        }
        setAnnotations(parseAnnotationFile(json)?.annotations ?? [])
        setStatus('ready')
      })
      .catch((cause: unknown) => {
        if (!active) {
          return
        }
        console.error('read annotations failed:', cause)
        setAnnotations([])
        setStatus('error')
      })
    return () => {
      active = false
    }
  }, [pdfPath, generation])

  // Flush a pending write before the PDF or graph session changes (and on
  // unmount), so the last edit never evaporates with the panel — and a timer
  // for the old PDF can never fire after the new one's load replaced the
  // state. The cleanup runs before the load effect's body, so `annotationsRef`
  // still holds the old PDF's edits when it lands.
  useEffect(() => {
    return () => {
      const pending = pendingRef.current
      if (pending === null) {
        return
      }
      clearTimeout(pending.timer)
      pendingRef.current = null
      const file: AnnotationFile = {
        version: 1,
        path: pending.path,
        annotations: annotationsRef.current,
      }
      persist(pending.path, JSON.stringify(file))
    }
  }, [pdfPath, generation, persist])

  const mutate = useCallback(
    (next: AnnotationItem[]): void => {
      setAnnotations(next)
      scheduleWrite()
    },
    [scheduleWrite],
  )

  const addAnnotation = useCallback(
    (annotation: Omit<AnnotationItem, 'id'>): void => {
      mutate([...annotationsRef.current, { ...annotation, id: crypto.randomUUID() }])
    },
    [mutate],
  )

  const updateAnnotation = useCallback(
    (id: string, patch: Partial<Omit<AnnotationItem, 'id'>>): void => {
      mutate(
        annotationsRef.current.map((annotation) =>
          annotation.id === id ? { ...annotation, ...patch } : annotation,
        ),
      )
    },
    [mutate],
  )

  const removeAnnotation = useCallback(
    (id: string): void => {
      mutate(annotationsRef.current.filter((annotation) => annotation.id !== id))
    },
    [mutate],
  )

  return { annotations, status, addAnnotation, updateAnnotation, removeAnnotation }
}
