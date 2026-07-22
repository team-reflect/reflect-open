import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  noteEditorHandleFor,
  subscribeNoteEditorHandle,
} from '@/editor/editor-handle-registry'
import {
  EMPTY_NOTE_FIND_SNAPSHOT,
  type NoteFindBeginOptions,
  type NoteFindDirection,
  type NoteFindSnapshot,
} from '@/editor/note-find'
import type { NoteEditorHandle } from '@/editor/note-editor'
import {
  listenForFocusedNoteMenuCommands,
  type FocusedNoteMenuCommand,
} from '@/lib/native-menu/dispatch'
import { isMainWindow } from '@/lib/windows/window-role'
import { useToday } from '@/lib/use-today'
import { useFocusedDailyDate } from '@/providers/focused-daily-provider'
import { focusedNotePathForRoute } from '@/routing/route'
import { useRouter } from '@/routing/router'

interface ActiveFindSession {
  readonly path: string
  handle: NoteEditorHandle | null
  beginOptions: NoteFindBeginOptions | undefined
  unsubscribeFind: () => void
  unsubscribeHandle: () => void
}

/** Render state and actions for the current window's Find bar. */
export interface NoteFindValue {
  readonly open: boolean
  readonly path: string | null
  readonly query: string
  readonly snapshot: NoteFindSnapshot
  /** Increments whenever repeated Cmd+F should reselect the query. */
  readonly focusRequest: number
  openForPath(path: string | null, beginOptions?: NoteFindBeginOptions): boolean
  updateQuery(query: string): void
  next(): void
  previous(): void
  close(): void
}

const NoteFindContext = createContext<NoteFindValue | null>(null)

/** Stable Find actions for command and native-menu dispatch. */
export interface NoteFindActions {
  openForPath(path: string | null, beginOptions?: NoteFindBeginOptions): boolean
  updateQuery(query: string): void
  next(): void
  previous(): void
  close(): void
}

const NoteFindActionsContext = createContext<NoteFindActions | null>(null)

/** One note-local Find session for the current webview window. */
export function NoteFindProvider({ children }: { children: ReactNode }): ReactElement {
  const { route } = useRouter()
  const today = useToday()
  const focusedDailyDate = useFocusedDailyDate()
  const currentPath = focusedNotePathForRoute(route, today, focusedDailyDate)
  const sessionRef = useRef<ActiveFindSession | null>(null)
  const queryRef = useRef('')
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [snapshot, setSnapshot] = useState<NoteFindSnapshot>(EMPTY_NOTE_FIND_SNAPSHOT)
  const [focusRequest, setFocusRequest] = useState(0)

  const closeSession = useCallback((restoreFocus: boolean): void => {
    const session = sessionRef.current
    if (session !== null) {
      sessionRef.current = null
      session.unsubscribeFind()
      session.unsubscribeHandle()
      session.handle?.clearFind()
      if (restoreFocus && session.handle !== null) {
        session.handle.focus()
      }
    }
    setOpen(false)
    setPath(null)
    setSnapshot(EMPTY_NOTE_FIND_SNAPSHOT)
  }, [])

  const attachSessionHandle = useCallback(
    (session: ActiveFindSession, handle: NoteEditorHandle | null): void => {
      if (sessionRef.current !== session || session.handle === handle) {
        return
      }
      if (handle === null) {
        closeSession(false)
        return
      }
      session.unsubscribeFind()
      session.unsubscribeFind = () => {}
      session.handle?.clearFind()
      session.handle = handle
      session.unsubscribeFind = handle.subscribeFind(setSnapshot)
      setSnapshot(
        session.beginOptions === undefined
          ? handle.beginFind(queryRef.current)
          : handle.beginFind(queryRef.current, session.beginOptions),
      )
    },
    [closeSession],
  )

  const openForPath = useCallback(
    (targetPath: string | null, beginOptions?: NoteFindBeginOptions): boolean => {
      if (targetPath === null) {
        return false
      }
      const existing = sessionRef.current
      if (existing?.path === targetPath) {
        setFocusRequest((request) => request + 1)
        return true
      }

      closeSession(false)

      const session: ActiveFindSession = {
        path: targetPath,
        handle: null,
        beginOptions,
        unsubscribeFind: () => {},
        unsubscribeHandle: () => {},
      }
      sessionRef.current = session
      session.unsubscribeHandle = subscribeNoteEditorHandle(targetPath, (mountedHandle) => {
        attachSessionHandle(session, mountedHandle)
      })
      attachSessionHandle(session, noteEditorHandleFor(targetPath))

      setPath(targetPath)
      setOpen(true)
      setFocusRequest((request) => request + 1)
      return true
    },
    [attachSessionHandle, closeSession],
  )

  const updateQuery = useCallback((nextQuery: string): void => {
    queryRef.current = nextQuery
    setQuery(nextQuery)
    const handle = sessionRef.current?.handle
    if (handle !== null && handle !== undefined) {
      setSnapshot(handle.updateFindQuery(nextQuery))
    }
  }, [])

  const resume = useCallback(
    (resumeDirection: NoteFindDirection): boolean => {
      if (queryRef.current.length === 0) {
        return false
      }
      return openForPath(currentPath, {
        direction: resumeDirection,
        resume: true,
      })
    },
    [currentPath, openForPath],
  )

  const next = useCallback((): void => {
    const session = sessionRef.current
    const handle = session?.handle
    if (handle !== null && handle !== undefined) {
      setSnapshot(handle.findNext())
    } else if (session === null) {
      resume('next')
    } else {
      session.beginOptions = { ...session.beginOptions, direction: 'next' }
    }
  }, [resume])

  const previous = useCallback((): void => {
    const session = sessionRef.current
    const handle = session?.handle
    if (handle !== null && handle !== undefined) {
      setSnapshot(handle.findPrevious())
    } else if (session === null) {
      resume('previous')
    } else {
      session.beginOptions = { ...session.beginOptions, direction: 'previous' }
    }
  }, [resume])

  const close = useCallback((): void => closeSession(true), [closeSession])

  useLayoutEffect(() => {
    const session = sessionRef.current
    if (session !== null && session.path !== currentPath) {
      closeSession(false)
    }
  }, [closeSession, currentPath])

  useEffect(() => {
    function onEscape(event: KeyboardEvent): void {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !event.isComposing &&
        sessionRef.current !== null
      ) {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [close])

  useEffect(() => {
    if (isMainWindow()) {
      return
    }
    let disposed = false
    let unlistenMenu = (): void => {}

    function onMenuCommand(command: FocusedNoteMenuCommand): void {
      switch (command) {
        case 'note.find':
          openForPath(currentPath)
          break
        case 'note.findNext':
          next()
          break
        case 'note.findPrevious':
          previous()
          break
      }
    }

    void listenForFocusedNoteMenuCommands(onMenuCommand)
      .then((unlisten) => {
        if (disposed) {
          unlisten()
        } else {
          unlistenMenu = unlisten
        }
      })
      .catch((cause: unknown) => {
        console.error('note menu listener failed:', cause)
      })

    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.altKey || event.repeat || event.isComposing) {
        return
      }
      const mod = event.metaKey || event.ctrlKey
      if (!mod) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'f' && !event.shiftKey) {
        if (openForPath(currentPath)) {
          event.preventDefault()
        }
        return
      }
      if (
        key === 'g' &&
        (sessionRef.current !== null || queryRef.current.length > 0)
      ) {
        event.preventDefault()
        if (event.shiftKey) {
          previous()
        } else {
          next()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      disposed = true
      unlistenMenu()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [currentPath, next, openForPath, previous])

  useEffect(() => () => closeSession(false), [closeSession])

  const value = useMemo<NoteFindValue>(
    () => ({
      open,
      path,
      query,
      snapshot,
      focusRequest,
      openForPath,
      updateQuery,
      next,
      previous,
      close,
    }),
    [
      open,
      path,
      query,
      snapshot,
      focusRequest,
      openForPath,
      updateQuery,
      next,
      previous,
      close,
    ],
  )
  const actions = useMemo<NoteFindActions>(
    () => ({ openForPath, updateQuery, next, previous, close }),
    [openForPath, updateQuery, next, previous, close],
  )

  return (
    <NoteFindActionsContext.Provider value={actions}>
      <NoteFindContext.Provider value={value}>{children}</NoteFindContext.Provider>
    </NoteFindActionsContext.Provider>
  )
}

/** Access the current window's note-local Find session. */
export function useNoteFind(): NoteFindValue {
  const value = useContext(NoteFindContext)
  if (value === null) {
    throw new Error('useNoteFind must be used within NoteFindProvider')
  }
  return value
}

/** Stable Find actions for shortcut plumbing that does not render Find UI. */
export function useNoteFindActions(): NoteFindActions {
  const value = useContext(NoteFindActionsContext)
  if (value === null) {
    throw new Error('useNoteFindActions must be used within NoteFindProvider')
  }
  return value
}
