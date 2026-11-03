import {
  createContext,
  useCallback,
  use,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

/**
 * Open state for the note history dialog, provided once per workspace so the
 * Note actions button and the palette command (via CommandContext) share one
 * definition of "open", the same shape as the templates provider.
 */

interface NoteHistoryContextValue {
  /** Graph-relative path of the note whose history is open; `null` when closed. */
  historyPath: string | null
  openNoteHistory: (path: string) => void
  closeNoteHistory: () => void
}

const NoteHistoryContext = createContext<NoteHistoryContextValue | null>(null)

export function NoteHistoryProvider({ children }: { children: ReactNode }): ReactElement {
  const [historyPath, setHistoryPath] = useState<string | null>(null)

  const openNoteHistory = useCallback((path: string) => {
    setHistoryPath(path)
  }, [])
  const closeNoteHistory = useCallback(() => {
    setHistoryPath(null)
  }, [])

  const value = useMemo<NoteHistoryContextValue>(
    () => ({ historyPath, openNoteHistory, closeNoteHistory }),
    [historyPath, openNoteHistory, closeNoteHistory],
  )
  return <NoteHistoryContext value={value}>{children}</NoteHistoryContext>
}

export function useNoteHistory(): NoteHistoryContextValue {
  const context = use(NoteHistoryContext)
  if (!context) {
    throw new Error('useNoteHistory must be used within a NoteHistoryProvider')
  }
  return context
}
