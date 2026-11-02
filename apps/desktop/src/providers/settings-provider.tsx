import type {
  DateFormat,
  EditorMarkdownSyntax,
  EditorTextSize,
  Settings,
  SettingsService,
  Store,
  ThemePreference,
  TimeFormat,
  WeekStartDay,
} from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useStore, useSelector } from '@/lib/use-store.ts'
import { isDeepEqual } from '@ocavue/utils'

export function useSettingsService(): SettingsService {
  return useCoreServices().settings satisfies Store<Settings>
}

export function useSettingsStore(): Settings {
  const store = useSettingsService()
  return useStore(store)
}

function useSettingsSelector<T>(selector: (settings: Settings) => T): T {
  const store = useSettingsService()
  return useSelector(store, selector, isDeepEqual)
}

function selectDateFormat(settings: Settings): DateFormat {
  return settings.dateFormat
}

function selectTimeFormat(settings: Settings): TimeFormat {
  return settings.timeFormat
}

function selectWeekStartDay(settings: Settings): WeekStartDay {
  return settings.weekStartDay
}

function selectEditorSmoothCaretAnimation(
  settings: Settings,
): Settings['editorSmoothCaretAnimation'] {
  return settings.editorSmoothCaretAnimation
}

function selectEditorSpellCheck(settings: Settings): Settings['editorSpellCheck'] {
  return settings.editorSpellCheck
}

function selectEditorMarkdownSyntax(settings: Settings): EditorMarkdownSyntax {
  return settings.editorMarkdownSyntax
}

function selectContactsEnabled(settings: Settings): Settings['contactsEnabled'] {
  return settings.contactsEnabled
}

function selectSemanticSearchEnabled(settings: Settings): Settings['semanticSearchEnabled'] {
  return settings.semanticSearchEnabled
}

function selectEditorTextSize(settings: Settings): EditorTextSize {
  return settings.editorTextSize
}

function selectEditorFullWidth(settings: Settings): Settings['editorFullWidth'] {
  return settings.editorFullWidth
}

function selectEditorDefaultBullet(settings: Settings): Settings['editorDefaultBullet'] {
  return settings.editorDefaultBullet
}

function selectEditorBulletAfterHeading(settings: Settings): Settings['editorBulletAfterHeading'] {
  return settings.editorBulletAfterHeading
}

function selectCalendarEnabled(settings: Settings): Settings['calendarEnabled'] {
  return settings.calendarEnabled
}

function selectTranscriptionPrompt(settings: Settings): Settings['transcriptionPrompt'] {
  return settings.transcriptionPrompt
}

function selectTranscriptionFormat(settings: Settings): Settings['transcriptionFormat'] {
  return settings.transcriptionFormat
}

function selectTheme(settings: Settings): ThemePreference {
  return settings.theme
}

function selectSidebarWidth(settings: Settings): Settings['sidebarWidth'] {
  return settings.sidebarWidth
}

function selectContextSidebarWidth(settings: Settings): Settings['contextSidebarWidth'] {
  return settings.contextSidebarWidth
}

function selectChatSystemPrompt(settings: Settings): Settings['chatSystemPrompt'] {
  return settings.chatSystemPrompt
}

function selectCalendarIds(settings: Settings): Settings['calendarIds'] {
  return settings.calendarIds
}

function selectAllNotesFilterTags(settings: Settings): Settings['allNotesFilterTags'] {
  return settings.allNotesFilterTags
}

function selectGraphColors(settings: Settings): Settings['graphColors'] {
  return settings.graphColors
}

function selectDescribeAssets(settings: Settings): Settings['describeAssets'] {
  return settings.describeAssets
}

function selectAiProviders(settings: Settings): Settings['aiProviders'] {
  return settings.aiProviders
}

export function useDateFormat(): DateFormat {
  return useSettingsSelector(selectDateFormat)
}

export function useTimeFormat(): TimeFormat {
  return useSettingsSelector(selectTimeFormat)
}

export function useWeekStartDay(): WeekStartDay {
  return useSettingsSelector(selectWeekStartDay)
}

export function useEditorSmoothCaretAnimation(): Settings['editorSmoothCaretAnimation'] {
  return useSettingsSelector(selectEditorSmoothCaretAnimation)
}

export function useEditorSpellCheck(): Settings['editorSpellCheck'] {
  return useSettingsSelector(selectEditorSpellCheck)
}

export function useEditorMarkdownSyntax(): EditorMarkdownSyntax {
  return useSettingsSelector(selectEditorMarkdownSyntax)
}

export function useContactsEnabled(): Settings['contactsEnabled'] {
  return useSettingsSelector(selectContactsEnabled)
}

export function useSemanticSearchEnabled(): Settings['semanticSearchEnabled'] {
  return useSettingsSelector(selectSemanticSearchEnabled)
}

export function useEditorTextSize(): EditorTextSize {
  return useSettingsSelector(selectEditorTextSize)
}

export function useEditorFullWidth(): Settings['editorFullWidth'] {
  return useSettingsSelector(selectEditorFullWidth)
}

export function useEditorDefaultBullet(): Settings['editorDefaultBullet'] {
  return useSettingsSelector(selectEditorDefaultBullet)
}

export function useEditorBulletAfterHeading(): Settings['editorBulletAfterHeading'] {
  return useSettingsSelector(selectEditorBulletAfterHeading)
}

export function useCalendarEnabled(): Settings['calendarEnabled'] {
  return useSettingsSelector(selectCalendarEnabled)
}

export function useTranscriptionPrompt(): Settings['transcriptionPrompt'] {
  return useSettingsSelector(selectTranscriptionPrompt)
}

export function useTranscriptionFormat(): Settings['transcriptionFormat'] {
  return useSettingsSelector(selectTranscriptionFormat)
}

export function useThemeSetting(): ThemePreference {
  return useSettingsSelector(selectTheme)
}

export function useSidebarWidth(): Settings['sidebarWidth'] {
  return useSettingsSelector(selectSidebarWidth)
}

export function useContextSidebarWidth(): Settings['contextSidebarWidth'] {
  return useSettingsSelector(selectContextSidebarWidth)
}

export function useChatSystemPrompt(): Settings['chatSystemPrompt'] {
  return useSettingsSelector(selectChatSystemPrompt)
}

export function useCalendarIds(): Settings['calendarIds'] {
  return useSettingsSelector(selectCalendarIds)
}

export function useAllNotesFilterTags(): Settings['allNotesFilterTags'] {
  return useSettingsSelector(selectAllNotesFilterTags)
}

export function useGraphColorsSetting(): Settings['graphColors'] {
  return useSettingsSelector(selectGraphColors)
}

export function useDescribeAssets(): Settings['describeAssets'] {
  return useSettingsSelector(selectDescribeAssets)
}

export function useAiProvidersSetting(): Settings['aiProviders'] {
  return useSettingsSelector(selectAiProviders)
}
