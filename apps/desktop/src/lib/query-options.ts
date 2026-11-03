import { infiniteQueryOptions, queryOptions, skipToken } from '@tanstack/react-query'
import type {
  CoreServices,
  DailyNoteService,
  IndexQueryService,
  NoteHistoryService,
  NoteRevision,
} from '@reflect/core'
import { queryKeys } from '@/lib/query-client.ts'

/** Templates shared by the settings list and insertion picker. */
export function createTemplatesQueryOptions(
  indexQuery: IndexQueryService,
  root: string | undefined,
) {
  return queryOptions({
    queryKey: queryKeys.index.templates(root),
    queryFn: () => indexQuery.listTemplates(),
  })
}

/** Daily-note dates shared by desktop and mobile calendars. */
export function createDailyDatesQueryOptions(
  dailyNotes: DailyNoteService,
  root: string | undefined,
  start: string,
  end: string,
) {
  return queryOptions({
    queryKey: queryKeys.index.dailyDates(root, start, end),
    queryFn: () => dailyNotes.dailyDatesInRange(start, end),
  })
}

/** Persisted chat conversations shared by desktop and mobile history menus. */
export function createChatConversationsQueryOptions(
  chatHistory: CoreServices['chatHistory'],
  root: string | undefined,
) {
  return queryOptions({
    queryKey: queryKeys.chat.conversations(root),
    queryFn: () => chatHistory.listRecent(),
  })
}

/**
 * The revisions of the note at `path`, paged newest first. Refetched each
 * time a list mounts: new commits land every few seconds of editing.
 */
export function createNoteRevisionsQueryOptions(
  noteHistory: NoteHistoryService,
  root: string | undefined,
  path: string,
) {
  return infiniteQueryOptions({
    queryKey: queryKeys.noteHistory.revisions(root, path),
    queryFn: ({ pageParam }) => noteHistory.revisions(path, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: root !== undefined,
  })
}

/**
 * The note's full text at `revision`; `null` selects nothing. A revision
 * never changes, so its text never goes stale.
 */
export function createNoteRevisionTextQueryOptions(
  noteHistory: NoteHistoryService,
  root: string | undefined,
  revision: NoteRevision | null,
) {
  return queryOptions({
    queryKey: queryKeys.noteHistory.revisionText(root, revision?.oid ?? '', revision?.path ?? ''),
    queryFn:
      root === undefined || revision === null
        ? skipToken
        : () => noteHistory.revisionText(revision),
    staleTime: Infinity,
  })
}
