import type { CoreServices } from '@reflect/core'
import type { ClipboardService } from './app/clipboard-service.ts'
import {
  createOpenerService,
  type OpenerService,
  type OpenerTransport,
} from './app/opener-service.ts'
import { createCommandService, type CommandService } from './commands/command-service.ts'
import { createKeymapService, type KeymapService } from './commands/keymap-service.ts'
import {
  createNativeMenuService,
  createUnsupportedNativeMenuHost,
  type NativeMenuHost,
  type NativeMenuService,
} from './commands/native-menu-service.ts'
import {
  createPaletteSearchService,
  type PaletteSearchService,
} from './search/palette-search-service.ts'
import {
  createDisabledExceptionTelemetry,
  type ExceptionTelemetryService,
} from './app/exception-telemetry-service.ts'
import {
  createUpdateService,
  type UpdaterAdapter,
  type UpdateService,
} from './app/update-service.ts'
import { createThemeService, type ThemeService } from './settings/theme-service.ts'
import { createKeyboardService, type KeyboardService } from './mobile/keyboard-service.ts'
import { createShareService, type ShareService } from './mobile/share-service.ts'
import {
  createAutocompleteSuggestionService,
  type AutocompleteSuggestionService,
} from './search/autocomplete-suggestion-service.ts'
import {
  createCalendarEventsService,
  type CalendarEventsService,
} from './calendar/calendar-events-service.ts'
import { createDeepLinkRouter, type DeepLinkRouter } from './navigation/deep-link-router.ts'
import type { OperationsService } from './app/operations-service.ts'
import {
  createLinkNavigationService,
  type LinkNavigationService,
} from './navigation/link-navigation-service.ts'
import { createNavigationService, type NavigationService } from './navigation/navigation-service.ts'
import type { AppLifecycleService } from './app/lifecycle-service.ts'
import { createQuitPolicyService, type QuitPolicyService } from './app/quit-policy-service.ts'
import type { WindowService } from './app/window-service.ts'
import type { DialogService } from './app/dialog-service.ts'
import {
  createPlatformService,
  type PlatformMedia,
  type PlatformService,
} from './app/platform-service.ts'
import {
  createMobileOnboardingService,
  type MobileOnboardingService,
} from './graph/mobile-onboarding-service.ts'
import { createGraphBootService, type GraphBootService } from './graph/graph-boot-service.ts'

/**
 * What the host supplies to the app layer: the window, lifecycle, storage,
 * updater, menu and deep-link primitives of one webview.
 */
export interface AppHost {
  /**
   * The window service the host built before the core services, which read its role.
   */
  readonly window: WindowService
  /**
   * Native open panels.
   */
  readonly dialog: DialogService
  /**
   * The media queries behind the reduced-motion and color-scheme signals;
   * defaults to the global `matchMedia`.
   */
  readonly media?: PlatformMedia
  /**
   * The lifecycle service the host built before the core services, which follow it as their activity port.
   */
  readonly lifecycle: AppLifecycleService
  /**
   * The app-wide list of visible background operations.
   */
  readonly operations: OperationsService
  /**
   * The system clipboard.
   */
  readonly clipboard: ClipboardService
  /**
   * The native operations behind the opener service.
   */
  readonly opener: OpenerTransport
  /**
   * Defaults to telemetry that reports nothing.
   */
  readonly exceptionTelemetry?: ExceptionTelemetryService
  /**
   * The native updater; without one, updates are unsupported.
   */
  readonly updater?: UpdaterAdapter
  /**
   * The native menus; without a host, every menu operation rejects.
   */
  readonly nativeMenu?: NativeMenuHost
}

/**
 * The app-layer services of one webview, built over the core services.
 */
export interface AppServices {
  /**
   * Facts about this webview's window and the actions that span windows.
   */
  readonly window: WindowService
  /**
   * Native open panels.
   */
  readonly dialog: DialogService
  /**
   * The platform facts plus the webview's reduced-motion and color-scheme signals.
   */
  readonly platform: PlatformService
  /**
   * The window-aware graph flows: the boot path, the folder picker, and the
   * opens and closes that end the session note windows adopted.
   */
  readonly graphBoot: GraphBootService
  /**
   * The mobile graph bootstrap into one of two fixed roots, the iCloud Drive container or the app sandbox.
   */
  readonly mobileOnboarding: MobileOnboardingService
  /**
   * The system clipboard.
   */
  readonly clipboard: ClipboardService
  /**
   * Hands URLs and paths to the operating system.
   */
  readonly opener: OpenerService
  /**
   * The central keymap registry that rejects duplicate shortcut bindings.
   */
  readonly keymap: KeymapService
  /**
   * The command registry. The app decides the context type that its commands run with.
   */
  readonly commands: CommandService
  /**
   * The native macOS application menu and native context menus.
   */
  readonly nativeMenu: NativeMenuService
  /**
   * The command palette's data layer.
   */
  readonly paletteSearch: PaletteSearchService
  /**
   * Exception-only crash reporting.
   */
  readonly exceptionTelemetry: ExceptionTelemetryService
  /**
   * The app theme: the `theme` setting resolved against the system color scheme.
   */
  readonly theme: ThemeService
  /**
   * Checks for, downloads, and installs app updates.
   */
  readonly update: UpdateService
  /**
   * The app-wide list of visible background operations.
   */
  readonly operations: OperationsService
  /**
   * The software keyboard's overlap height, as the UI last measured it.
   */
  readonly keyboard: KeyboardService
  /**
   * Shares a note through the OS share sheet.
   */
  readonly share: ShareService
  /**
   * The editor's `[[` and `#` menus.
   */
  readonly autocompleteSuggestions: AutocompleteSuggestionService
  /**
   * The calendar events behind the daily note's events panel, fetched live.
   */
  readonly calendarEvents: CalendarEventsService
  /**
   * The webview's navigation history; a note window has its own webview, hence its own.
   */
  readonly navigation: NavigationService
  /**
   * Turns the `reflect://` URLs of this webview into navigations.
   */
  readonly deepLinkRouter: DeepLinkRouter
  /**
   * Turns an activated link into a navigation, a new window, or a refusal.
   */
  readonly linkNavigation: LinkNavigationService
  /**
   * Application lifecycle signals and the shell's quit and background-task handshakes.
   */
  readonly lifecycle: AppLifecycleService
  /**
   * When the app lands its dirty state: on quit and window close, or on moving to the background.
   */
  readonly quitPolicy: QuitPolicyService
}

/**
 * Build the app layer once per webview.
 */
export function createAppServices(core: CoreServices, host: AppHost): AppServices {
  const platform = createPlatformService({ facts: core.platform, media: host.media })
  const commands = createCommandService({ platform: core.platform, logger: core.logger })
  const keymap = createKeymapService({ platform: core.platform })
  const nativeMenu = createNativeMenuService({
    commands,
    window: host.window,
    platform: core.platform,
    ipc: core.ipc,
    logger: core.logger,
    host: host.nativeMenu ?? createUnsupportedNativeMenuHost(),
  })
  const paletteSearch = createPaletteSearchService({
    suggestions: core.suggestions,
    search: core.search,
    retrieval: core.retrieval,
    commands,
    clock: core.clock,
  })
  const opener = createOpenerService({ transport: host.opener, logger: core.logger })
  const navigation = createNavigationService()
  const deepLinkRouter = createDeepLinkRouter({
    intake: core.deepLinkIntake,
    logger: core.logger,
    graphSession: core.graphSession,
  })
  const linkNavigation = createLinkNavigationService({
    noteLinkResolver: core.noteLinkResolver,
    noteCreation: core.noteCreation,
    wikiResolver: core.wikiResolver,
    window: host.window,
    platform: core.platform,
    opener,
    deepLinkRouter,
    navigation,
    attachments: core.attachments,
    operations: host.operations,
    logger: core.logger,
    graphSession: core.graphSession,
  })
  return {
    window: host.window,
    dialog: host.dialog,
    platform,
    graphBoot: createGraphBootService({
      graphSession: core.graphSession,
      window: host.window,
      dialog: host.dialog,
      path: core.path,
      platform: core.platform,
      deepLinkRouter,
      logger: core.logger,
    }),
    mobileOnboarding: createMobileOnboardingService({
      mobileStorage: core.mobileStorage,
      settings: core.settings,
      graphSession: core.graphSession,
      platform: core.platform,
      clock: core.clock,
      activity: host.lifecycle,
      logger: core.logger,
    }),
    clipboard: host.clipboard,
    opener,
    commands,
    keymap,
    nativeMenu,
    paletteSearch,
    exceptionTelemetry: host.exceptionTelemetry ?? createDisabledExceptionTelemetry(),
    theme: createThemeService({
      settings: core.settings,
      storage: core.storage,
      platform,
    }),
    update: createUpdateService({
      updater: host.updater,
      clock: core.clock,
      logger: core.logger,
      platform: core.platform,
      window: host.window,
    }),
    operations: host.operations,
    keyboard: createKeyboardService(),
    share: createShareService({ openDocuments: core.openDocuments }),
    autocompleteSuggestions: createAutocompleteSuggestionService({
      suggestions: core.suggestions,
      noteCreation: core.noteCreation,
      contacts: core.contacts,
      personNotes: core.personNotes,
      settings: core.settings,
      clock: core.clock,
      operations: host.operations,
      logger: core.logger,
      graphSession: core.graphSession,
    }),
    calendarEvents: createCalendarEventsService({
      calendar: core.calendar,
      settings: core.settings,
      platform: core.platform,
      lifecycle: host.lifecycle,
      logger: core.logger,
    }),
    navigation,
    deepLinkRouter,
    linkNavigation,
    lifecycle: host.lifecycle,
    quitPolicy: createQuitPolicyService({
      lifecycle: host.lifecycle,
      window: host.window,
      platform: core.platform,
      persistenceFlush: core.persistenceFlush,
    }),
  }
}
