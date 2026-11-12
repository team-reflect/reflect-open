import { installQueryInvalidation } from '@/lib/query-invalidation.ts'
import { installUncaughtErrorLogging } from '@/lib/uncaught-errors.ts'
import { createDesktopAdapters, createDesktopHost } from '@/services/create-desktop-services.ts'
import { createDeferredIpcTransport } from '@/services/deferred-ipc.ts'
import { detectHostKind, detectPlatformFacts } from '@/services/detect-platform.ts'
import { installNativeChrome } from '@/services/native-chrome-transport.ts'
import { installHostEvents } from '@/services/swift-events.ts'
import { createSwiftIpcTransport } from '@/services/swift-ipc.ts'
import { createSwiftLogger } from '@/services/swift-logger.ts'
import { createTauriIpcTransport } from '@/services/tauri-ipc.ts'
import { createTauriLogger } from '@/services/tauri-logger.ts'
import { createAppGraphServices, createAppServices } from '@reflect/app'
import {
  createConsoleLogger,
  createCoreServices,
  createIpcBridgeService,
  createSystemClock,
  type LoggerService,
} from '@reflect/core'

const hostKind = detectHostKind(window)
const facts = detectPlatformFacts(hostKind)

/**
 * Plain-browser dev (`pnpm dev` without the shell) has no transport yet: the
 * platform root connects the in-memory dev transport here once it is ready.
 * `null` inside a native shell. Features that need the real shell rather
 * than an answering transport gate on `isNativeShell()`.
 */
export const pendingDevIpc = hostKind === 'browser' ? createDeferredIpcTransport() : null

const transport =
  pendingDevIpc?.transport ??
  (hostKind === 'swift' ? createSwiftIpcTransport(fetch) : createTauriIpcTransport())

function createLogger(): LoggerService {
  switch (hostKind) {
    case 'tauri':
      return createTauriLogger(createConsoleLogger())
    case 'swift':
      return createSwiftLogger(createConsoleLogger(), transport)
    case 'browser':
      return createConsoleLogger()
  }
}

const logger = createLogger()
if (hostKind === 'swift') {
  installHostEvents(window, logger)
  installNativeChrome(window, document.documentElement)
}
const clock = createSystemClock()
const ipc = createIpcBridgeService({ transport, logger })

const host = createDesktopHost(facts, hostKind, { ipc, clock, logger })
const role = host.window.isMainWindow() ? 'main' : 'note-window'

const adapters = createDesktopAdapters(facts, hostKind, { ipc, logger, clock }, role)

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
installUncaughtErrorLogging(window, logger)
installQueryInvalidation(coreServices, appServices)
void coreServices.contacts.refresh()
