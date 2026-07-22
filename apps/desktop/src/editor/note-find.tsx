import { useMemo } from 'react'
import { type MarkMode, type TypedEditor } from '@meowdown/core'
import { useExtension } from '@meowdown/react'
import { definePlugin, defineUpdateHandler } from '@prosekit/core'
import {
  findNext,
  findPrev,
  getMatchHighlights,
  getSearchState,
  search,
  setSearchState,
} from 'prosemirror-search'
import { TextSelection } from 'prosemirror-state'
import { NoteFindQuery } from './note-find-query'

export interface NoteFindSnapshot {
  /** One-based active match, or zero when there is no active match. */
  readonly active: number
  readonly total: number
}

export const EMPTY_NOTE_FIND_SNAPSHOT: NoteFindSnapshot = { active: 0, total: 0 }

/** Direction used when continuing a retained Find query. */
export type NoteFindDirection = 'next' | 'previous'

/** Controls where a newly opened Find session selects its first result. */
export interface NoteFindBeginOptions {
  readonly direction?: NoteFindDirection
  /** Continue from the last active result instead of the current caret. */
  readonly resume?: boolean
}

export interface NoteFindController {
  /** Attach the mounted editor instance and its current syntax display mode. */
  bind(editor: TypedEditor | undefined, markMode: MarkMode): void
  /** Start a find session from the current caret. */
  begin(query: string, options?: NoteFindBeginOptions): NoteFindSnapshot
  /** Replace the active query while retaining the session's starting point. */
  updateQuery(query: string): NoteFindSnapshot
  next(): NoteFindSnapshot
  previous(): NoteFindSnapshot
  /** Remove highlights and leave a safe caret after the active match. */
  clear(): void
  /** Recompute match counts after an editor document change. */
  refresh(): void
  subscribe(listener: (snapshot: NoteFindSnapshot) => void): () => void
}

function snapshotFor(editor: TypedEditor): NoteFindSnapshot {
  const matches = getMatchHighlights(editor.state).find()
  const { from, to } = editor.state.selection
  const activeIndex = matches.findIndex((match) => match.from === from && match.to === to)
  return { active: activeIndex < 0 ? 0 : activeIndex + 1, total: matches.length }
}

function queryFor(queryText: string, markMode: MarkMode): NoteFindQuery {
  return new NoteFindQuery(queryText, { includeSyntax: markMode === 'show' })
}

interface MatchBookmark {
  readonly query: string
  readonly document: TypedEditor['state']['doc']
  readonly from: number
  readonly to: number
}

function createController(
  initialEditor: TypedEditor | undefined,
  initialMarkMode: MarkMode,
): NoteFindController {
  const listeners = new Set<(snapshot: NoteFindSnapshot) => void>()
  let boundEditor = initialEditor
  let boundMarkMode = initialMarkMode
  let disposeSelectionObserver: VoidFunction | null = null
  let origin = 0
  let direction: NoteFindDirection = 'next'
  let currentQueryText = ''
  let queryActive = false
  let queryNeedsSync = false
  let resumeMatch: MatchBookmark | null = null
  let lastMatch: MatchBookmark | null = null

  function publish(snapshot: NoteFindSnapshot): NoteFindSnapshot {
    for (const listener of listeners) {
      listener(snapshot)
    }
    return snapshot
  }

  function publishEditor(editor: TypedEditor): NoteFindSnapshot {
    const snapshot = snapshotFor(editor)
    if (snapshot.active > 0) {
      lastMatch = {
        query: currentQueryText,
        document: editor.state.doc,
        from: editor.state.selection.from,
        to: editor.state.selection.to,
      }
    }
    return publish(snapshot)
  }

  function currentEditor(): TypedEditor | null {
    const editor = boundEditor
    return editor?.mounted && getSearchState(editor.state) !== undefined ? editor : null
  }

  function setQuery(queryText: string): NoteFindSnapshot {
    currentQueryText = queryText
    const query = queryFor(queryText, boundMarkMode)
    queryActive = query.valid
    const editor = currentEditor()
    if (editor === null) {
      queryNeedsSync = true
      return publish(EMPTY_NOTE_FIND_SNAPSHOT)
    }

    queryNeedsSync = false
    const { selection } = editor.state
    const selectionIsFindMatch = getMatchHighlights(editor.state)
      .find()
      .some((match) => match.from === selection.from && match.to === selection.to)
    let transaction = editor.state.tr
    if (selectionIsFindMatch && !selection.empty) {
      transaction = transaction.setSelection(
        TextSelection.create(transaction.doc, selection.to),
      )
    }
    transaction = setSearchState(transaction, query)
    if (query.valid) {
      const documentEnd = editor.state.doc.content.size
      const clampedOrigin = Math.min(origin, documentEnd)
      const match =
        direction === 'next'
          ? query.findNext(
              editor.state,
              resumeMatch?.to ?? clampedOrigin,
              documentEnd,
            ) ??
            query.findNext(
              editor.state,
              0,
              resumeMatch?.from ?? clampedOrigin,
            )
          : query.findPrev(
              editor.state,
              resumeMatch?.from ?? clampedOrigin,
              0,
            ) ??
            query.findPrev(
              editor.state,
              documentEnd,
              resumeMatch?.to ?? clampedOrigin,
            )
      if (match !== null) {
        transaction = transaction
          .setSelection(TextSelection.create(transaction.doc, match.from, match.to))
          .scrollIntoView()
      }
    }
    resumeMatch = null
    editor.view.dispatch(transaction)
    return publishEditor(editor)
  }

  function move(command: typeof findNext): NoteFindSnapshot {
    const editor = currentEditor()
    if (editor === null) {
      return publish(EMPTY_NOTE_FIND_SNAPSHOT)
    }
    editor.exec(command)
    direction = command === findPrev ? 'previous' : 'next'
    return publishEditor(editor)
  }

  function bind(editor: TypedEditor | undefined, markMode: MarkMode): void {
    const editorChanged = boundEditor !== editor
    const searchProjectionChanged =
      (boundMarkMode === 'show') !== (markMode === 'show')
    boundMarkMode = markMode
    if (editorChanged || disposeSelectionObserver === null) {
      disposeSelectionObserver?.()
      boundEditor = editor
      disposeSelectionObserver =
        editor?.use(
          defineUpdateHandler((view, previousState) => {
            if (!view.state.selection.eq(previousState.selection)) {
              publishEditor(editor)
            }
          }),
        ) ?? null
    }

    if (
      (queryNeedsSync ||
        (queryActive && (editorChanged || searchProjectionChanged))) &&
      currentEditor() !== null
    ) {
      setQuery(currentQueryText)
    }
  }

  const controller: NoteFindController = {
    bind,
    begin: (query, options = {}) => {
      const editor = currentEditor()
      origin = editor?.state.selection.from ?? 0
      direction = options.direction ?? 'next'
      resumeMatch =
        options.resume === true &&
        lastMatch?.query === query &&
        lastMatch.document === editor?.state.doc
          ? lastMatch
          : null
      return setQuery(query)
    },
    updateQuery: (query) => {
      direction = 'next'
      return setQuery(query)
    },
    next: () => move(findNext),
    previous: () => move(findPrev),
    clear: () => {
      setQuery('')
    },
    refresh: () => {
      const editor = currentEditor()
      if (editor === null) {
        publish(EMPTY_NOTE_FIND_SNAPSHOT)
      } else {
        publishEditor(editor)
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  bind(initialEditor, initialMarkMode)
  return controller
}

/** Installs ProseMirror's decoration state in the enclosing Meowdown editor. */
export function NoteFindExtension(): null {
  const extension = useMemo(() => definePlugin(search()), [])
  useExtension(extension)
  return null
}

/** Create the imperative find controller owned by one NoteEditor instance. */
export function createNoteFindController(
  editor?: TypedEditor,
  markMode: MarkMode = 'hide',
): NoteFindController {
  return createController(editor, markMode)
}
