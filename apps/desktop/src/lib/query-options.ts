import { queryOptions } from '@tanstack/react-query'
import type { CoreServices, DailyNoteService, IndexQueryService } from '@reflect/core'
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
