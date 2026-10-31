/**
 * `@reflect/app`: the app layer over `@reflect/core`. It knows windows, routes,
 * commands and menus, and nothing about React or Tauri. The desktop app builds
 * it once per webview with `createAppServices(core, host)`.
 */
export { createAppServices, type AppHost, type AppServices } from './create-app-services.ts'
export {
  type ExceptionErrorHandler,
  type ExceptionErrorInfo,
  type ExceptionRootOptions,
  type ExceptionTelemetryService,
} from './app/exception-telemetry-service.ts'
export {
  createLifecycleService,
  type AppLifecycleService,
  type LifecycleDomAdapter,
} from './app/lifecycle-service.ts'
export { type QuitPolicyService } from './app/quit-policy-service.ts'
export {
  createOperationsService,
  LINGER_MS,
  MIN_VISIBLE_MS,
  type OperationsService,
} from './app/operations-service.ts'
export {
  type AvailableUpdate,
  type UpdaterAdapter,
  type UpdateService,
  type UpdateState,
} from './app/update-service.ts'
export {
  createThemeService,
  THEME_PREFERENCE_CACHE_KEY,
  type ResolvedTheme,
  type ThemeService,
} from './settings/theme-service.ts'
export { type ClipboardService } from './app/clipboard-service.ts'
export {
  type OpenerService,
  type OpenerTransport,
  type SystemSettingsPane,
} from './app/opener-service.ts'
export { type KeyboardService } from './mobile/keyboard-service.ts'
export { type ShareService } from './mobile/share-service.ts'
export {
  getMobileSyncStatus,
  signInNeededText,
  type MobileSyncDetail,
  type MobileSyncStatus,
} from './sync/mobile-sync-status.ts'
export { remoteLabel } from './sync/remote-label.ts'
export {
  createConnectGithubWizardService,
  type ConnectAuthKind,
  type ConnectFinishView,
  type ConnectGithubWizardDeps,
  type ConnectGithubWizardOptions,
  type ConnectGithubWizardService,
  type ConnectWizardStep,
} from './sync/connect-github-wizard-service.ts'
export {
  type AutocompleteSuggestionService,
  type TagMenuItem,
  type WikiLinkMenuItem,
} from './search/autocomplete-suggestion-service.ts'
export {
  buildAutocompleteEntries,
  type AutocompleteEntry,
  type ContactEntryCandidate,
  type EntryOptions,
} from './search/wiki-autocomplete-entries.ts'
export {
  EMPTY_ALL_NOTES_FILTERS,
  buildAllNotesSearch,
  hasActiveFilters,
  pendingTagToken,
  searchPlanFor,
  updatedRangeFilter,
  type AllNotesFilters,
  type NoteFilterRef,
  type PendingTag,
} from './search/all-notes-filters.ts'
export {
  countSelectedCalendars,
  groupCalendarsBySource,
  showsDayEvents,
  type CalendarEventsService,
} from './calendar/calendar-events-service.ts'
export { dailyArrivalIntent } from './daily/daily-arrivals.ts'
export {
  createDayWindow,
  dateAtIndex,
  extendDayWindowBack,
  FUTURE_DAYS,
  indexOfDate,
  indexWithin,
  neighborDate,
  PAST_DAYS,
  type DayWindow,
  type DayWindowRadius,
} from './daily/day-window.ts'
export {
  buildMonthGrid,
  formatMonthLabel,
  formatShortMonthLabel,
  getWeekdayLabels,
  type MonthGrid,
  type MonthGridCell,
} from './daily/month-grid.ts'
export {
  createWeekWindow,
  monthPickTarget,
  WEEK_WINDOW_RADIUS,
  weekAtIndex,
  weekIndexOf,
  weekOf,
  type WeekWindow,
} from './daily/week-window.ts'
export { type Command, type CommandService } from './commands/command-service.ts'
export { formatBinding } from './commands/keybindings.ts'
export { type KeymapService } from './commands/keymap-service.ts'
export {
  type AppMenuEntry,
  type AppSubmenuLayout,
  type FocusedNoteMenuCommand,
  type NativeContextMenuOptions,
  type NativeMenuHost,
  type NativeMenuItem,
  type NativeMenuPredefinedItem,
  type NativeMenuService,
  type NativeSubmenu,
} from './commands/native-menu-service.ts'
export {
  buildPaletteSections,
  type NoteEntry,
  type PaletteHit,
  type PaletteSections,
} from './search/palette-entries.ts'
export { type PaletteSearchService } from './search/palette-search-service.ts'
export { deepLinkForRoute } from './navigation/deep-link-format.ts'
export { type DeepLinkRouter } from './navigation/deep-link-router.ts'
export {
  routeForTag,
  type LinkNavigationHost,
  type LinkNavigationService,
} from './navigation/link-navigation-service.ts'
export { type NavigateOptions, type NavigationService } from './navigation/navigation-service.ts'
export {
  effectiveDailyDate,
  focusedNotePathForRoute,
  normalizeRoute,
  notePathForRoute,
  routeForPath,
  routesEqual,
  type NoteRoute,
  type Route,
} from './navigation/route.ts'
export {
  createWindowService,
  createSingleWindowHost,
  MAIN_WINDOW_LABEL,
  type CloseRequestedHandler,
  type WindowHost,
  type WindowService,
} from './app/window-service.ts'
export {
  type DialogFilter,
  type DialogService,
  type PickFilesOptions,
  type PickFolderOptions,
} from './app/dialog-service.ts'
export {
  createPlatformService,
  type ColorScheme,
  type PlatformMedia,
  type PlatformService,
} from './app/platform-service.ts'
export { type GraphBootService } from './graph/graph-boot-service.ts'
export {
  type MobileOnboardingService,
  type MobileOnboardingState,
} from './graph/mobile-onboarding-service.ts'
export { createAppGraphServices, type AppGraphServicesDeps } from './graph/graph-lifecycles.ts'
