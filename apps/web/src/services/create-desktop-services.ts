import {
  createLifecycleService,
  createOperationsService,
  createSingleWindowHost,
  createWindowService,
  type AppHost,
} from '@reflect/app'
import {
  createBrowserHttpService,
  createNoDeepLinkSource,
  createPosixPathTransport,
  reachWebStorage,
  type ClockService,
  type CoreAdapters,
  type GraphRole,
  type IpcBridgeService,
  type LoggerService,
  type PlatformFacts,
} from '@reflect/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  buildExceptionTelemetryDsn,
  createExceptionTelemetry,
  sentryExceptionTelemetrySdk,
} from '@/lib/exception-telemetry.ts'
import { createNavigatorClipboardService } from '@/services/browser-clipboard.ts'
import { createBrowserDialogService } from '@/services/browser-dialog.ts'
import { createBrowserOpenerTransport } from '@/services/browser-opener.ts'
import { createBrowserImageCodec } from '@/services/browser-image-codec.ts'
import { createDomLifecycleAdapter } from '@/services/dom-lifecycle.ts'
import type { HostKind } from '@/services/detect-platform.ts'
import { createTauriDeepLinkSource } from '@/services/tauri-deep-link.ts'
import { createTauriDialogService } from '@/services/tauri-dialog.ts'
import { createTauriNativeMenuHost } from '@/services/native-menu.ts'
import { createTauriHttpService } from '@/services/tauri-http.ts'
import { createTauriOpenerTransport } from '@/services/tauri-opener.ts'
import { createTauriPathTransport } from '@/services/tauri-path.ts'
import { createTauriUpdaterAdapter } from '@/services/tauri-updater.ts'
import { createTauriWindowHost } from '@/services/tauri-window.ts'
import { createSwiftDeepLinkSource } from '@/services/swift-deep-link.ts'
import { createSwiftHttpService } from '@/services/swift-http.ts'
import { createSwiftOpenerTransport } from '@/services/swift-opener.ts'

/**
 * The host primitives that `boot.ts` builds once and shares between the layers.
 */
export interface DesktopPrimitives {
  readonly ipc: IpcBridgeService
  readonly clock: ClockService
  readonly logger: LoggerService
}

/**
 * The desktop app's core adapters for `hostKind`: the Tauri ones in the
 * Tauri shell, the Swift ones in the Swift shell, the browser ones in
 * plain-browser dev. `role` is this webview's window role.
 */
export function createDesktopAdapters(
  facts: PlatformFacts,
  hostKind: HostKind,
  { ipc, logger, clock }: DesktopPrimitives,
  role: GraphRole,
): Omit<CoreAdapters, 'ipc' | 'activity' | 'progress' | 'role' | 'createGraphServices'> {
  const common = {
    platform: facts,
    clock,
    logger,
    storage: {
      local: reachWebStorage(logger, 'localStorage'),
      session: reachWebStorage(logger, 'sessionStorage'),
    },
    imageCodec: createBrowserImageCodec(),
  }
  switch (hostKind) {
    case 'tauri':
      return {
        ...common,
        http: createTauriHttpService(),
        path: createTauriPathTransport(),
        convertFileSrc,
        // The OS delivers deep links to every webview; only the main window takes them.
        deepLink: role === 'main' ? createTauriDeepLinkSource() : createNoDeepLinkSource(),
      }
    case 'swift':
      return {
        ...common,
        http: createSwiftHttpService(fetch),
        path: createPosixPathTransport('/'),
        deepLink: createSwiftDeepLinkSource(ipc, logger),
      }
    case 'browser':
      return {
        ...common,
        http: createBrowserHttpService(),
        path: createPosixPathTransport('/'),
      }
  }
}

/**
 * The desktop app's host for the app layer: the window service, the lifecycle
 * service and the operations list over the page, the Tauri dialogs, updater
 * and native menus inside the Tauri shell, and Sentry exception telemetry
 * everywhere.
 */
export function createDesktopHost(
  facts: PlatformFacts,
  hostKind: HostKind,
  { ipc, clock, logger }: DesktopPrimitives,
): AppHost {
  const lifecycle = createLifecycleService({ ipc, dom: createDomLifecycleAdapter(), clock, logger })
  const windowHost =
    hostKind === 'tauri' ? createTauriWindowHost({ logger }) : createSingleWindowHost()
  const common = {
    window: createWindowService({ ipc, host: windowHost, logger }),
    lifecycle,
    operations: createOperationsService({ clock }),
    clipboard: createNavigatorClipboardService(),
  }
  const exceptionTelemetry = createExceptionTelemetry({
    dsn: buildExceptionTelemetryDsn(),
    release: `reflect@${facts.appVersion}`,
    os: facts.buildPlatform ?? 'unknown',
    sdk: sentryExceptionTelemetrySdk,
    logger,
  })
  switch (hostKind) {
    case 'tauri':
      return {
        ...common,
        dialog: createTauriDialogService(),
        opener: createTauriOpenerTransport(),
        exceptionTelemetry,
        updater: createTauriUpdaterAdapter(),
        nativeMenu: createTauriNativeMenuHost(),
      }
    case 'swift':
      return {
        ...common,
        dialog: createBrowserDialogService(),
        opener: createSwiftOpenerTransport(ipc),
        exceptionTelemetry,
      }
    case 'browser':
      return {
        ...common,
        dialog: createBrowserDialogService(),
        opener: createBrowserOpenerTransport(),
        exceptionTelemetry,
      }
  }
}
