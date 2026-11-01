import { installQueryInvalidation } from '@/lib/query-invalidation.ts'
import { createDesktopAdapters, createDesktopHost } from '@/services/create-desktop-services.ts'
import { createDeferredIpcTransport } from '@/services/deferred-ipc.ts'
import { detectPlatformFacts } from '@/services/detect-platform.ts'
import { createTauriIpcTransport } from '@/services/tauri-ipc.ts'
import { createTauriLogger } from '@/services/tauri-logger.ts'
import { createAppGraphServices, createAppServices } from '@reflect/app'
import {
  createConsoleLogger,
  createCoreServices,
  createIpcBridgeService,
  createSystemClock,
} from '@reflect/core'
import { isTauri } from '@tauri-apps/api/core'

const facts = detectPlatformFacts(isTauri())

/**
 * Plain-browser dev (`pnpm dev` without the shell) has no transport yet: the
 * platform root connects the in-memory dev transport here once it is ready.
 * `null` inside a Tauri webview. Features that need the real shell rather
 * than an answering transport gate on `isNativeShell()`.
 */
export const pendingDevIpc = facts.isNativeShell ? null : createDeferredIpcTransport()

const logger = facts.isNativeShell
  ? createTauriLogger(createConsoleLogger())
  : createConsoleLogger()
const clock = createSystemClock()
const ipc = createIpcBridgeService({
  transport: pendingDevIpc?.transport ?? createTauriIpcTransport(),
  logger,
})

const host = createDesktopHost(facts, { ipc, clock, logger })
const role = host.window.isMainWindow() ? 'main' : 'note-window'

const adapters = createDesktopAdapters(facts, { logger, clock }, role)

/**
 * The app-scoped services of this webview.
 */
export const coreServices = createCoreServices({
  ...adapters,
  convertFileSrc: pendingDevIpc?.convertFileSrc ?? adapters.convertFileSrc,
  ipc,
  role,
  activity: host.lifecycle,
  progress: host.operations,
  // Called when a graph opens, after both layers below exist.
  createGraphServices: (session, deps) => {
    return createAppGraphServices(session, deps, {
      platform: coreServices.platform,
      settings: coreServices.settings,
      mobileOnboarding: appServices.mobileOnboarding,
    })
  },
})

export const appServices = createAppServices(coreServices, host)

// Runs before every module imported after this one, so exception telemetry
// exists while the rest of the app's modules evaluate.
appServices.exceptionTelemetry.install()
installQueryInvalidation(coreServices, appServices)
void coreServices.contacts.refresh()
