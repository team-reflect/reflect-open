import { mutationOptions, queryOptions } from '@tanstack/react-query'
import {
  dailyDatesInRange,
  getConflictedNotes,
  getDuplicateNoteIds,
  listChatConversations,
  listTemplates,
  loadSettings,
  saveSettings,
} from '@reflect/core'
import { mutationKeys, mutationScopeIds, queryKeys } from '@/lib/query-client'

/** Conflicted-note rows shared by every sync status and settings surface. */
export function createConflictedNotesQueryOptions(root: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.index.conflictedNotes(root),
    queryFn: getConflictedNotes,
  })
}

/** Duplicate note IDs shared by the Git and iCloud settings surfaces. */
export function createDuplicateNoteIdsQueryOptions(root: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.index.duplicateNoteIds(root),
    queryFn: getDuplicateNoteIds,
  })
}

/** Templates shared by the settings list and insertion picker. */
export function createTemplatesQueryOptions(root: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.index.templates(root),
    queryFn: listTemplates,
  })
}

/** Daily-note dates shared by desktop and mobile calendars. */
export function createDailyDatesQueryOptions(root: string | undefined, start: string, end: string) {
  return queryOptions({
    queryKey: queryKeys.index.dailyDates(root, start, end),
    queryFn: () => dailyDatesInRange(start, end),
  })
}

/** Persisted chat conversations shared by desktop and mobile history menus. */
export function createChatConversationsQueryOptions(root: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.chat.conversations(root),
    queryFn: () => listChatConversations(),
  })
}

export function createSettingsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.settings.all,
    queryFn: loadSettings,
    staleTime: Infinity,
  })
}
export function createSettingsSaveMutationOptions() {
  return mutationOptions({
    mutationKey: mutationKeys.settings.save,
    mutationFn: saveSettings,
    scope: { id: mutationScopeIds.settingsSave },
    retry: 0,
  })
}
