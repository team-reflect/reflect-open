import { queryOptions } from '@tanstack/react-query'
import {
  dailyDatesInRange,
  getConflictedNotes,
  getDuplicateNoteIds,
  listChatConversations,
  listTemplates,
} from '@reflect/core'
import { queryKeys } from '@/lib/query-client'

/** Conflicted-note rows shared by every sync status and settings surface. */
export const createConflictedNotesQueryOptions = (root: string | undefined) =>
  queryOptions({
    queryKey: queryKeys.index.conflictedNotes(root),
    queryFn: getConflictedNotes,
  })

/** Duplicate note IDs shared by the Git and iCloud settings surfaces. */
export const createDuplicateNoteIdsQueryOptions = (root: string | undefined) =>
  queryOptions({
    queryKey: queryKeys.index.duplicateNoteIds(root),
    queryFn: getDuplicateNoteIds,
  })

/** Templates shared by the settings list and insertion picker. */
export const createTemplatesQueryOptions = (root: string | undefined) =>
  queryOptions({
    queryKey: queryKeys.index.templates(root),
    queryFn: listTemplates,
  })

/** Daily-note dates shared by desktop and mobile calendars. */
export const createDailyDatesQueryOptions = (
  root: string | undefined,
  start: string,
  end: string,
) =>
  queryOptions({
    queryKey: queryKeys.index.dailyDates(root, start, end),
    queryFn: () => dailyDatesInRange(start, end),
  })

/** Persisted chat conversations shared by desktop and mobile history menus. */
export const createChatConversationsQueryOptions = (root: string | undefined) =>
  queryOptions({
    queryKey: queryKeys.chat.conversations(root),
    queryFn: listChatConversations,
  })
