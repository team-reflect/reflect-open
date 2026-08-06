import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { getIsComposing, type SearchStatus } from '@meowdown/core'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry'
import {
  listenForFocusedNoteMenuCommands,
  type FocusedNoteMenuCommand,
} from '@/lib/native-menu/dispatch'
import { useToday } from '@/lib/use-today'
import { isMainWindow } from '@/lib/windows/window-role'
import { useFocusedDailyDate } from '@/providers/focused-daily-provider'
import { focusedNotePathForRoute } from '@/routing/route'
import { useRouter } from '@/routing/router'

const NO_MATCHES: SearchStatus = { total: 0, active: 0 }

/** Which note the window is searching, and for what. */
interface FindTarget {
  readonly path: string
  readonly query: string
}

/** Render state for the window's Find bar. */
export interface NoteFindValue {
  readonly open: boolean
  readonly query: string
  readonly status: SearchStatus
  /** Increments whenever a repeated ⌘F should reselect the query. */
  readonly focusRequest: number
  updateQuery(query: string): void
  next(): void
  previous(): void
  close(restoreFocus: boolean): void
}

/** Find actions for command and native-menu dispatch, stable across renders. */
export interface NoteFindActions {
  /** Opens Find for a note path. Returns false when there is no note to search. */
  openForPath(path: string | null): boolean
  next(): void
  previous(): void
  close(restoreFocus: boolean): void
}

const NoteFindContext = createContext<NoteFindValue | null>(null)
const NoteFindActionsContext = createContext<NoteFindActions | null>(null)
const NoteFindTargetContext = createContext<FindTarget | null>(null)
const NoteFindReportContext = createContext<(path: string, status: SearchStatus) => void>(() => {})

/** One note-local Find session for the current webview window. */
export function NoteFindProvider({ children }: { children: ReactNode }): ReactElement {
  const { route, arrivalSeq } = useRouter()
  const today = useToday()
  const focusedDailyDate = useFocusedDailyDate()
  const notePath = focusedNotePathForRoute(route, today, focusedDailyDate)

  const [session, setSession] = useState<{ path: string; arrival: number } | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<SearchStatus>(NO_MATCHES)
  const [focusRequest, setFocusRequest] = useState(0)
  // Set by ⌘G on a closed bar, consumed once the pane has applied the query.
  const pendingStepRef = useRef(0)

  // The session belongs to one note reached by one navigation, so leaving that
  // note (or arriving at it again) ends it with no teardown of its own.
  const target =
    session !== null && session.path === notePath && session.arrival === arrivalSeq
      ? session.path
      : null

  const openForPath = useCallback(
    (path: string | null): boolean => {
      if (path === null) return false
      setSession({ path, arrival: arrivalSeq })
      setFocusRequest((request) => request + 1)
      return true
    },
    [arrivalSeq],
  )

  const stepIn = useCallback((path: string, step: 1 | -1): void => {
    const handle = noteEditorHandleFor(path)
    if (step > 0) handle?.findNext()
    else handle?.findPrevious()
  }, [])

  const move = useCallback(
    (step: 1 | -1): void => {
      if (target !== null) {
        stepIn(target, step)
        return
      }
      // ⌘G with the bar closed resumes the last query, then advances once the
      // pane has pushed it into the editor.
      if (query.length > 0 && openForPath(notePath)) pendingStepRef.current = step
    },
    [notePath, openForPath, query, stepIn, target],
  )

  // Runs when a session opens. The pane's own effect went first (child effects
  // precede the parent's), so a resumed query is already in the editor here.
  useEffect(() => {
    const step = pendingStepRef.current
    if (step === 0 || target === null) return
    pendingStepRef.current = 0
    stepIn(target, step > 0 ? 1 : -1)
  }, [stepIn, target])

  const close = useCallback(
    (restoreFocus: boolean): void => {
      const handle = target === null ? null : noteEditorHandleFor(target)
      setSession(null)
      setStatus(NO_MATCHES)
      if (restoreFocus) handle?.focus()
    },
    [target],
  )

  const next = useCallback((): void => move(1), [move])
  const previous = useCallback((): void => move(-1), [move])

  const report = useCallback(
    (path: string, nextStatus: SearchStatus): void => {
      if (path === target) setStatus(nextStatus)
    },
    [target],
  )

  useEffect(() => {
    if (target === null) return
    function onEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented || getIsComposing()) return
      // Never consume the key: meowdown owns Escape inside the editor (its
      // menus close on it) and an overlay above the bar owns its own. This
      // only ends a Find session the user has already navigated away from.
      if (event.target instanceof Element && event.target.closest('.ProseMirror') !== null) {
        return
      }
      close(false)
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [close, target])

  // A detached note window renders no command palette and installs no menu, so
  // it listens for the shortcuts and the routed menu events itself.
  useEffect(() => {
    if (isMainWindow()) return
    let disposed = false
    let unlistenMenu = (): void => {}

    function onMenuCommand(command: FocusedNoteMenuCommand): void {
      switch (command) {
        case 'note.find':
          openForPath(notePath)
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
        if (disposed) unlisten()
        else unlistenMenu = unlisten
      })
      .catch((cause: unknown) => {
        console.error('note menu listener failed:', cause)
      })

    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.altKey || event.repeat || getIsComposing()) return
      if (!event.metaKey && !event.ctrlKey) return
      const key = event.key.toLowerCase()
      if (key === 'f' && !event.shiftKey) {
        if (openForPath(notePath)) event.preventDefault()
        return
      }
      if (key === 'g' && (target !== null || query.length > 0)) {
        event.preventDefault()
        if (event.shiftKey) previous()
        else next()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      disposed = true
      unlistenMenu()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [next, notePath, openForPath, previous, query, target])

  const value = useMemo<NoteFindValue>(
    () => ({
      open: target !== null,
      query,
      status,
      focusRequest,
      updateQuery: setQuery,
      next,
      previous,
      close,
    }),
    [close, focusRequest, next, previous, query, status, target],
  )
  const actions = useMemo<NoteFindActions>(
    () => ({ openForPath, next, previous, close }),
    [close, next, openForPath, previous],
  )
  const findTarget = useMemo<FindTarget | null>(
    () => (target === null ? null : { path: target, query }),
    [query, target],
  )

  return (
    <NoteFindActionsContext value={actions}>
      <NoteFindReportContext value={report}>
        <NoteFindTargetContext value={findTarget}>
          <NoteFindContext value={value}>{children}</NoteFindContext>
        </NoteFindTargetContext>
      </NoteFindReportContext>
    </NoteFindActionsContext>
  )
}

/** Access the current window's Find session. */
export function useNoteFind(): NoteFindValue {
  const value = use(NoteFindContext)
  if (value === null) {
    throw new Error('useNoteFind must be used within NoteFindProvider')
  }
  return value
}

/** Stable Find actions for shortcut plumbing that renders no Find UI. */
export function useNoteFindActions(): NoteFindActions {
  const value = use(NoteFindActionsContext)
  if (value === null) {
    throw new Error('useNoteFindActions must be used within NoteFindProvider')
  }
  return value
}

/** The search query for one note, empty when it is not the Find target. */
export function useNoteSearchQuery(path: string): string {
  const target = use(NoteFindTargetContext)
  return target?.path === path ? target.query : ''
}

/** Reports one note's search status to the window's Find session. */
export function useNoteSearchReport(): (path: string, status: SearchStatus) => void {
  return use(NoteFindReportContext)
}
