import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import { createTestFileChangeService } from '../testing/index.ts'
import { createTestLoggerService, type TestLoggerService } from '../testing/logger.ts'
import { createTestSettingsService } from '../testing/settings.ts'
import type { Unlisten } from '../unlisten.ts'
import {
  createPersistenceFlushService,
  type PersistenceFlushService,
} from './persistence-flush-service.ts'

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

interface Setup {
  service: PersistenceFlushService
  logger: TestLoggerService
  log: string[]
  documents: Step
  settings: Step
  gitSync: Step
}

const disposers: Unlisten[] = []

function setup(): Setup {
  const log: string[] = []
  const documents = createStep('documents', log)
  const settings = createStep('settings', log)
  const gitSync = createStep('git-sync', log)
  const logger = createTestLoggerService()
  const settingsService = createTestSettingsService()
  vi.spyOn(settingsService, 'flush').mockImplementation(settings.fn)
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  vi.spyOn(openDocuments, 'flushAll').mockImplementation(documents.fn)
  const service = createPersistenceFlushService({
    settings: settingsService,
    openDocuments,
    logger,
  })
  disposers.push(service.registerFlusher('git-sync', gitSync.fn))
  return { service, logger, log, documents, settings, gitSync }
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

describe('flushAll', () => {
  it('flushes documents and settings in parallel, then backup', async () => {
    const { service, log, gitSync, documents } = setup()
    const release = documents.hold()

    const flushed = service.flushAll()
    await settle()
    expect(log).toEqual(['documents', 'settings'])

    release()
    await flushed
    expect(log).toEqual(['documents', 'settings', 'git-sync'])
    expect(gitSync.calls()).toBe(1)
  })

  it('never rejects and logs every failed step', async () => {
    const { service, documents, settings, gitSync, logger } = setup()
    documents.failNext('disk full')
    settings.failNext('settings failed')
    gitSync.failNext('commit failed')

    await expect(service.flushAll()).resolves.toBeUndefined()
    expect(gitSync.calls()).toBe(1)
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'documents flush failed:',
      'settings flush failed:',
      'git-sync flush failed:',
    ])
  })

  it('flushes documents and settings alone when no backup is registered', async () => {
    const { service, log } = setup()
    for (const dispose of disposers.splice(0)) {
      dispose()
    }

    await service.flushAll()
    expect(log).toEqual(['documents', 'settings'])
  })

  it('replaces a flusher of the same kind, and a stale remover keeps the new one', async () => {
    const { service, log } = setup()
    const first = createStep('first', log)
    const second = createStep('second', log)
    const removeFirst = service.registerFlusher('git-sync', first.fn)
    service.registerFlusher('git-sync', second.fn)
    removeFirst()

    await service.flushAll()
    expect(first.calls()).toBe(0)
    expect(second.calls()).toBe(1)
  })
})

describe('startFlushAll', () => {
  it('starts every flush without waiting for any', async () => {
    const { service, documents, log } = setup()
    const release = documents.hold()

    service.startFlushAll()
    expect(log).toEqual(['documents', 'settings', 'git-sync'])
    release()
    await settle()
  })

  it('logs every failed step', async () => {
    const { service, documents, gitSync, logger } = setup()
    documents.failNext('disk full')
    gitSync.failNext('commit failed')

    service.startFlushAll()
    await settle()
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'documents flush failed:',
      'git-sync flush failed:',
    ])
  })
})
