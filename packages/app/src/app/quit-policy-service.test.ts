import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPersistenceFlushService, type Unlisten } from '@reflect/core'
import {
  createNodeTestDatabaseService,
  createTestCoreServices,
  createTestLoggerService,
  createTestPlatformService,
  createTestSettingsService,
  type TestLoggerService,
  type TestPlatformOptions,
} from '@reflect/core/testing'
import { createTestLifecycleService, type TestLifecycleService } from '../testing/lifecycle.ts'
import { createTestWindowService } from '../testing/window.ts'
import type { WindowService } from './window-service.ts'
import type { AppLifecycleService } from './lifecycle-service.ts'
import { createQuitPolicyService, type QuitPolicyService } from './quit-policy-service.ts'

type CloseRequestedHandler = Parameters<WindowService['onCloseRequested']>[0]

/**
 * A flusher that records its calls and can hold or fail the next one.
 */
interface Step {
  readonly fn: () => Promise<void>
  calls(): number
  /**
   * The next call stays pending until the returned function runs.
   */
  hold(): () => void
  failNext(message: string): void
}

function createStep(name: string, log: string[]): Step {
  let count = 0
  let pending: Promise<void> | null = null
  let failure: string | null = null
  return {
    async fn() {
      count += 1
      log.push(name)
      const gate = pending
      pending = null
      if (gate !== null) {
        await gate
      }
      if (failure !== null) {
        const message = failure
        failure = null
        throw new Error(message)
      }
    },
    calls: () => count,
    hold() {
      const { promise, resolve } = Promise.withResolvers<void>()
      pending = promise
      return () => {
        resolve()
      }
    },
    failNext(message) {
      failure = message
    },
  }
}

interface CloseRequest {
  readonly completed: Promise<void>
  prevented(): boolean
}

interface Setup {
  service: QuitPolicyService
  lifecycle: TestLifecycleService
  window: WindowService & { hideCalls(): number }
  logger: TestLoggerService
  log: string[]
  documents: Step
  settings: Step
  backup: Step
  /**
   * Run the close-requested handlers without awaiting them.
   */
  requestClose: () => CloseRequest
}

const disposers: Unlisten[] = []

function setup(options?: {
  platform?: TestPlatformOptions
  windowLabel?: string
  hidden?: boolean
  failHide?: boolean
  lifecycle?: (
    base: Pick<AppLifecycleService, 'beginBackgroundTask' | 'endBackgroundTask'>,
    log: string[],
  ) => Partial<AppLifecycleService>
}): Setup {
  const log: string[] = []
  const documents = createStep('documents', log)
  const settings = createStep('settings', log)
  const backup = createStep('backup', log)
  const lifecycle = createTestLifecycleService({
    hidden: options?.hidden ?? false,
    backgroundTasks: true,
  })
  const original = {
    beginBackgroundTask: lifecycle.beginBackgroundTask.bind(lifecycle),
    endBackgroundTask: lifecycle.endBackgroundTask.bind(lifecycle),
  }
  Object.assign(lifecycle, options?.lifecycle?.(original, log))
  const closeHandlers = new Set<CloseRequestedHandler>()
  let hides = 0
  const window = Object.assign(
    createTestWindowService(
      options?.windowLabel === undefined ? undefined : { label: options.windowLabel },
    ),
    {
      onCloseRequested(handler: CloseRequestedHandler): Unlisten {
        closeHandlers.add(handler)
        return () => {
          closeHandlers.delete(handler)
        }
      },
      hide() {
        hides += 1
        log.push('hide')
        if (options?.failHide ?? false) {
          return Promise.reject(new Error('hide failed'))
        }
        return Promise.resolve()
      },
      hideCalls: () => hides,
    },
  )
  const logger = createTestLoggerService()
  const settingsService = createTestSettingsService()
  vi.spyOn(settingsService, 'flush').mockImplementation(settings.fn)
  const { openDocuments } = createTestCoreServices({ database: createNodeTestDatabaseService() })
  vi.spyOn(openDocuments, 'flushAll').mockImplementation(documents.fn)
  const persistenceFlush = createPersistenceFlushService({
    settings: settingsService,
    openDocuments,
    logger,
  })
  disposers.push(persistenceFlush.registerFlusher('backup', backup.fn))
  const service = createQuitPolicyService({
    lifecycle,
    window,
    platform: createTestPlatformService(options?.platform),
    persistenceFlush,
  })
  return {
    service,
    lifecycle,
    window,
    logger,
    log,
    documents,
    settings,
    backup,
    requestClose() {
      let prevented = false
      const event = {
        preventDefault: () => {
          prevented = true
        },
      }
      const completed = Promise.all(
        [...closeHandlers].map(async (handler) => {
          await handler(event)
        }),
      ).then(() => {})
      return { completed, prevented: () => prevented }
    },
  }
}

function install(uninstall: Unlisten): void {
  disposers.push(uninstall)
}

/**
 * Let every pending promise continuation run.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose()
  }
})

describe('installDesktopQuitPolicy', () => {
  it.each(['documents', 'settings'] as const)(
    'hides the main window before pending saves and backup finish (%s finish first)',
    async (firstSave) => {
      const { service, documents, settings, backup, window, requestClose } = setup()
      const releaseDocuments = documents.hold()
      const releaseSettings = settings.hold()
      install(service.installDesktopQuitPolicy())

      const close = requestClose()
      expect(close.prevented()).toBe(true)
      expect(window.hideCalls()).toBe(1)
      await settle()
      expect(documents.calls()).toBe(1)
      expect(settings.calls()).toBe(1)
      expect(backup.calls()).toBe(0)

      const [releaseFirst, releaseLast] =
        firstSave === 'documents'
          ? [releaseDocuments, releaseSettings]
          : [releaseSettings, releaseDocuments]
      releaseFirst()
      await settle()
      expect(backup.calls()).toBe(0)
      releaseLast()
      await close.completed
      expect(backup.calls()).toBe(1)
      expect(window.hideCalls()).toBe(1)
    },
  )

  it('still flushes if hiding the main window fails', async () => {
    const { service, documents, settings, backup, requestClose } = setup({ failHide: true })
    install(service.installDesktopQuitPolicy())

    const close = requestClose()
    await expect(close.completed).rejects.toThrow('hide failed')
    expect(close.prevented()).toBe(true)
    expect(documents.calls()).toBe(1)
    expect(settings.calls()).toBe(1)
    expect(backup.calls()).toBe(1)
  })

  it('waits for backup before confirming app quit', async () => {
    const { service, lifecycle, backup, window } = setup()
    const release = backup.hold()
    install(service.installDesktopQuitPolicy())

    lifecycle.emitQuitRequested()
    await settle()
    expect(backup.calls()).toBe(1)
    expect(lifecycle.confirmQuitCalls()).toBe(0)
    expect(window.hideCalls()).toBe(0)

    release()
    await settle()
    expect(lifecycle.confirmQuitCalls()).toBe(1)
  })

  it('confirms the quit even when a flush fails', async () => {
    const { service, lifecycle, documents } = setup()
    documents.failNext('disk full')
    install(service.installDesktopQuitPolicy())

    lifecycle.emitQuitRequested()
    await settle()
    expect(lifecycle.confirmQuitCalls()).toBe(1)
  })

  it('flushes and hides the macOS main window even when one flush rejects', async () => {
    const { service, documents, settings, backup, window, logger, requestClose } = setup()
    settings.failNext('settings flush failed')
    install(service.installDesktopQuitPolicy())

    const close = requestClose()
    expect(close.prevented()).toBe(true)
    await close.completed
    expect(documents.calls()).toBe(1)
    expect(settings.calls()).toBe(1)
    expect(backup.calls()).toBe(1)
    expect(window.hideCalls()).toBe(1)
    expect(logger.getErrors()).toHaveLength(1)
  })

  it('allows the main window to close normally outside macOS', async () => {
    const { service, backup, window, requestClose } = setup({
      platform: { isMacosDesktop: false },
    })
    install(service.installDesktopQuitPolicy())

    const close = requestClose()
    expect(close.prevented()).toBe(false)
    await close.completed
    expect(window.hideCalls()).toBe(0)
    expect(backup.calls()).toBe(1)
  })

  it('allows secondary windows to close normally', async () => {
    const { service, documents, backup, window, requestClose } = setup({
      windowLabel: 'note-1',
    })
    install(service.installDesktopQuitPolicy())

    const close = requestClose()
    expect(close.prevented()).toBe(false)
    await close.completed
    expect(documents.calls()).toBe(1)
    expect(backup.calls()).toBe(1)
    expect(window.hideCalls()).toBe(0)
  })

  it('starts every flush on unload without waiting for any', async () => {
    const { service, lifecycle, documents, log } = setup()
    const release = documents.hold()
    install(service.installDesktopQuitPolicy())

    lifecycle.emitBeforeUnload()
    expect(log).toEqual(['documents', 'settings', 'backup'])
    release()
    await settle()
  })

  it('installs nothing outside the native shell', async () => {
    const { service, lifecycle, log, requestClose } = setup({
      platform: { isNativeShell: false },
    })
    install(service.installDesktopQuitPolicy())

    lifecycle.emitQuitRequested()
    lifecycle.emitBeforeUnload()
    await requestClose().completed
    await settle()
    expect(log).toEqual([])
    expect(lifecycle.confirmQuitCalls()).toBe(0)
  })

  it('stops listening after dispose', async () => {
    const { service, lifecycle, log, requestClose } = setup()
    service.installDesktopQuitPolicy()()

    lifecycle.emitQuitRequested()
    lifecycle.emitBeforeUnload()
    const close = requestClose()
    await close.completed
    await settle()
    expect(close.prevented()).toBe(false)
    expect(log).toEqual([])
  })
})

describe('installMobileBackgroundPolicy', () => {
  it('protects documents, settings, and the commit with one balanced task', async () => {
    const { service, lifecycle, log } = setup({
      lifecycle: (base, log) => ({
        async beginBackgroundTask() {
          log.push('begin')
          return await base.beginBackgroundTask()
        },
        async endBackgroundTask(token) {
          log.push(`end ${token}`)
          await base.endBackgroundTask(token)
        },
      }),
    })
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitHidden()
    await settle()

    expect(log).toEqual(['begin', 'documents', 'settings', 'backup', 'end background-task-1'])
    expect(lifecycle.backgroundTasks()).toEqual([{ token: 'background-task-1', ended: true }])
  })

  it('commits only after the buffers have landed', async () => {
    const { service, lifecycle, documents, backup } = setup()
    const release = documents.hold()
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitHidden()
    await settle()
    expect(backup.calls()).toBe(0)

    release()
    await settle()
    expect(backup.calls()).toBe(1)
  })

  it('still commits when a buffer flush fails', async () => {
    const { service, lifecycle, documents, backup } = setup()
    documents.failNext('disk full')
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitHidden()
    await settle()

    expect(backup.calls()).toBe(1)
    expect(lifecycle.backgroundTasks()).toEqual([{ token: 'background-task-1', ended: true }])
  })

  it('ends the task even when the commit fails', async () => {
    const { service, lifecycle, backup } = setup()
    backup.failNext('commit failed')
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitHidden()
    await settle()

    expect(lifecycle.backgroundTasks()).toEqual([{ token: 'background-task-1', ended: true }])
  })

  it('still flushes when native background time is unavailable', async () => {
    let ends = 0
    const { service, lifecycle, documents, backup } = setup({
      lifecycle: () => ({
        beginBackgroundTask: () => Promise.reject(new Error('no native bridge')),
        endBackgroundTask: () => {
          ends += 1
        },
      }),
    })
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitHidden()
    await settle()

    expect(documents.calls()).toBe(1)
    expect(backup.calls()).toBe(1)
    expect(ends).toBe(0)
  })

  it('does not end a task when the native shell returns none', async () => {
    let ends = 0
    const { service, lifecycle, documents, backup } = setup({
      lifecycle: () => ({
        beginBackgroundTask: () => null,
        endBackgroundTask: () => {
          ends += 1
        },
      }),
    })
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitHidden()
    await settle()

    expect(documents.calls()).toBe(1)
    expect(backup.calls()).toBe(1)
    expect(ends).toBe(0)
  })

  it('survives a failure to end the task', async () => {
    const { service, lifecycle, backup } = setup({
      lifecycle: () => ({
        endBackgroundTask: () => Promise.reject(new Error('expired')),
      }),
    })
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitHidden()
    await settle()
    expect(backup.calls()).toBe(1)

    lifecycle.emitVisible()
    lifecycle.emitHidden()
    await settle()
    expect(backup.calls()).toBe(2)
  })

  it('does nothing on becoming visible', async () => {
    const { service, lifecycle, log } = setup()
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitVisible()
    await settle()

    expect(log).toEqual([])
  })

  it('also flushes on pagehide', async () => {
    const { service, lifecycle, documents, backup } = setup()
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitPageHide()
    await settle()

    expect(documents.calls()).toBe(1)
    expect(backup.calls()).toBe(1)
  })

  it('does not flush for a page that starts hidden until a new transition', async () => {
    const { service, lifecycle, documents } = setup({ hidden: true })
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitPageHide()
    await settle()
    expect(documents.calls()).toBe(1)

    lifecycle.emitHidden()
    await settle()
    expect(documents.calls()).toBe(1)
  })

  it('coalesces hidden and pagehide from one background transition', async () => {
    const { service, lifecycle, documents, backup } = setup()
    const release = documents.hold()
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitHidden()
    lifecycle.emitPageHide()
    lifecycle.emitPageHide()
    await settle()
    expect(documents.calls()).toBe(1)
    expect(backup.calls()).toBe(0)

    release()
    await settle()
    expect(documents.calls()).toBe(1)
    expect(backup.calls()).toBe(1)
    expect(lifecycle.backgroundTasks()).toHaveLength(1)
  })

  it('queues one rerun for a genuine visible-to-hidden transition in flight', async () => {
    const { service, lifecycle, documents, backup } = setup()
    const release = documents.hold()
    install(service.installMobileBackgroundPolicy())

    lifecycle.emitHidden()
    lifecycle.emitVisible()
    lifecycle.emitHidden()
    lifecycle.emitPageHide()
    lifecycle.emitPageHide()
    await settle()
    expect(documents.calls()).toBe(1)

    release()
    await settle()
    expect(documents.calls()).toBe(2)
    expect(backup.calls()).toBe(2)
    expect(lifecycle.backgroundTasks()).toHaveLength(2)
  })

  it('stops listening after dispose', async () => {
    const { service, lifecycle, log } = setup()
    service.installMobileBackgroundPolicy()()

    lifecycle.emitHidden()
    lifecycle.emitPageHide()
    await settle()

    expect(log).toEqual([])
  })
})
