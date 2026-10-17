import type { CoreServices, GraphRole } from '@reflect/core'
import {
  createTestCoreServices,
  type TestActivityPort,
  type TestPlatformService,
} from '@reflect/core/testing'
import type { OperationsService } from '../app/operations-service.ts'
import { createPlatformService, type PlatformService } from '../app/platform-service.ts'
import { createThemeService } from '../settings/theme-service.ts'
import { createTestDialogService, type TestDialogService } from './dialog.ts'
import {
  createTestMobileOnboardingService,
  type TestMobileOnboardingService,
} from './mobile-onboarding.ts'
import { createTestWindowService, type TestWindowService } from './window.ts'
import { createAppServices, type AppHost, type AppServices } from '../create-app-services.ts'
import { createTestClipboardService, type TestClipboardService } from './clipboard.ts'
import { createTestNativeMenuHost } from './commands.ts'
import { createTestOpenerService, type TestOpenerService } from './opener.ts'
import { createLinkNavigationService } from '../navigation/link-navigation-service.ts'
import { createTestNavigationService, type TestNavigationService } from './navigation.ts'
import { createTestLifecycleService, type TestLifecycleService } from './lifecycle.ts'
import { createTestOperationsService } from './operations.ts'
import { createTestUpdaterAdapter } from './update.ts'

/**
 * {@link AppServices} where each service with a test double is that double.
 */
export type TestAppServices = Omit<
  AppServices,
  'navigation' | 'clipboard' | 'opener' | 'lifecycle' | 'window' | 'dialog' | 'mobileOnboarding'
> & {
  readonly window: TestWindowService
  readonly dialog: TestDialogService
  readonly mobileOnboarding: TestMobileOnboardingService
  readonly clipboard: TestClipboardService
  readonly opener: TestOpenerService
  readonly navigation: TestNavigationService
  readonly lifecycle: TestLifecycleService
}

/**
 * A host of silent doubles: a main test window, a dialog that cancels, a test
 * lifecycle, an operations list over a test clock, a recording clipboard and
 * an opener that opens nothing. `overrides` replace fields of the result.
 */
export function createTestAppHost(overrides: Partial<AppHost> = {}): AppHost {
  return {
    window: createTestWindowService(),
    dialog: createTestDialogService(),
    lifecycle: createTestLifecycleService(),
    operations: createTestOperationsService(),
    clipboard: createTestClipboardService(),
    opener: { openUrl: () => {}, revealItemInDir: () => {} },
    ...overrides,
  }
}

/**
 * Whether `platform` already answers the webview signals, as the core test platform does.
 */
function isTestPlatform(platform: CoreServices['platform']): platform is TestPlatformService {
  return 'colorScheme' in platform
}

/**
 * The app layer over test core services. Pass the core services a test built
 * (and observes) to share them with the app layer; their `progress` port, when
 * there is one, is the app's operations list, their test platform is the app's
 * platform, and their `role` picks the default test window (`note-1` for a
 * note window). `overrides` replace fields of the result and reach the app
 * services built over them.
 */
export function createTestAppServices(
  core: CoreServices & {
    readonly progress?: OperationsService
    readonly role?: GraphRole
  } = createTestCoreServices(),
  overrides: Partial<AppServices> = {},
): TestAppServices {
  const operations = overrides.operations ?? core.progress ?? createTestOperationsService()
  const window =
    overrides.window ??
    createTestWindowService(core.role === 'note-window' ? { label: 'note-1' } : undefined)
  const dialog = overrides.dialog ?? createTestDialogService()
  const platform: PlatformService =
    overrides.platform ??
    (isTestPlatform(core.platform)
      ? core.platform
      : createPlatformService({ facts: core.platform }))
  const clipboard = overrides.clipboard ?? createTestClipboardService()
  const opener = overrides.opener ?? createTestOpenerService({ logger: core.logger })
  const navigation = overrides.navigation ?? createTestNavigationService()
  // Over the core's test activity port, so one emit reaches both layers.
  const activity = (core as { activity?: TestActivityPort }).activity
  const lifecycle =
    overrides.lifecycle ??
    createTestLifecycleService(activity === undefined ? undefined : { activity })
  const app = createAppServices(core, {
    ...createTestAppHost({ window, dialog, operations, clipboard, lifecycle }),
    updater: createTestUpdaterAdapter(),
    nativeMenu: createTestNativeMenuHost(),
  })
  const deepLinkRouter = overrides.deepLinkRouter ?? app.deepLinkRouter
  const mobileOnboarding =
    overrides.mobileOnboarding ??
    createTestMobileOnboardingService({
      mobileStorage: core.mobileStorage,
      settings: core.settings,
      graphSession: core.graphSession,
      platform: core.platform,
      clock: core.clock,
      activity: lifecycle,
      logger: core.logger,
    })
  const linkNavigation =
    overrides.linkNavigation ??
    createLinkNavigationService({
      noteLinkResolver: core.noteLinkResolver,
      noteCreation: core.noteCreation,
      wikiResolver: core.wikiResolver,
      window,
      platform: core.platform,
      opener,
      deepLinkRouter,
      navigation,
      attachments: core.attachments,
      operations,
      logger: core.logger,
      graphSession: core.graphSession,
    })
  return {
    ...app,
    theme: createThemeService({ settings: core.settings, storage: core.storage, platform }),
    ...overrides,
    window,
    dialog,
    platform,
    mobileOnboarding,
    clipboard,
    opener,
    lifecycle,
    navigation,
    deepLinkRouter,
    linkNavigation,
  } as TestAppServices
}
