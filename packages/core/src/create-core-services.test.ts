import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseSearchQuery } from './indexing/filter-query.ts'
import { createTestClockService } from './testing/clock.ts'
import { createTestDatabaseService, seedNotes } from './testing/database.ts'
import { createTestNoteFileService } from './testing/graph.ts'
import { createTestHttpService } from './testing/http.ts'
import { createTestIpcBridgeService } from './testing/ipc.ts'
import { createTestLoggerService } from './testing/logger.ts'
import { createTestPlatformService } from './testing/platform.ts'
import { createTestProgressPort } from './testing/ports.ts'
import { createTestCoreServices } from './testing/services.ts'
import { createTestActivityPort } from './testing/shell.ts'
import { createNoteDocumentService } from './documents/note-document-service.ts'
import {
  composeCoreServices,
  createCoreServices,
  type CoreAdapters,
} from './create-core-services.ts'
import { createPosixPathTransport } from './ports/path-service.ts'

function requiredAdapters(): CoreAdapters {
  const ipc = createTestIpcBridgeService({ commands: { app_version: () => '1.2.3' } })
  return {
    ipc,
    platform: createTestPlatformService(),
    role: 'main',
    progress: createTestProgressPort(),
    http: createTestHttpService(),
    storage: { local: null, session: null },
    path: createPosixPathTransport('/home/test'),
    activity: createTestActivityPort(),
    logger: createTestLoggerService(),
    clock: createTestClockService({ now: 5 }),
    createGraphServices: (session) => {
      throw new Error(`no graph services for ${session.root}`)
    },
  }
}

function setup() {
  const adapters = requiredAdapters()
  return { adapters, services: createCoreServices(adapters) }
}

describe('createCoreServices', () => {
  it('passes the given services through and builds the rest over the adapters', async () => {
    const { adapters, services } = setup()
    expect(services.logger).toBe(adapters.logger)
    expect(services.clock).toBe(adapters.clock)
    expect(services.platform).toBe(adapters.platform)
    await expect(services.ipc.call('app_version', {}, z.string())).resolves.toBe('1.2.3')
    expect(services.platform.appVersion).toBe('0.0.0-test')
    await expect(services.path.homeDir()).resolves.toBe('/home/test')
  })

  it('defaults the id', () => {
    const services = createCoreServices(requiredAdapters())
    expect(services.id.noteId()).toMatch(/^[0-9a-z]{26}$/)
  })

  it('composes the mobile services on mobile only', () => {
    const desktop = createCoreServices({ ...requiredAdapters(), logger: createTestLoggerService() })
    expect(desktop.mobile).toBeNull()
    expect(desktop.audioMemo).toBeDefined()
    expect(desktop.classicAccess).toBeDefined()

    const mobile = createCoreServices({
      ...requiredAdapters(),
      logger: createTestLoggerService(),
      platform: createTestPlatformService({ appPlatform: 'ios' }),
    })
    expect(mobile.mobile?.haptics).toBeDefined()
    expect(mobile.mobile?.subscription).toBeDefined()
    expect(mobile.mobile?.appStoreEnvironment).toBeDefined()
    expect(mobile.mobile?.paywall).toBeDefined()
    expect(mobile.mobile?.mobileAudioMemo).toBeDefined()
  })

  it('echoes own writes onto the file-change stream on mobile only', () => {
    for (const [appPlatform, echoed] of [
      ['desktop', 0],
      ['ios', 1],
    ] as const) {
      const services = createCoreServices({
        ...requiredAdapters(),
        logger: createTestLoggerService(),
        platform: createTestPlatformService({ appPlatform }),
      })
      let batches = 0
      services.fileChanges.subscribe(() => {
        batches++
      })
      services.fileChanges.reportOwnWrite([{ path: 'notes/a.md', kind: 'upsert' }])
      expect(batches, appPlatform).toBe(echoed)
    }
  })

  it('reports note writes to the composed file-change service', async () => {
    const ipc = createTestIpcBridgeService({
      commands: { note_write: () => ({ modifiedMs: null, merged: null }) },
    })
    const { services, internal } = composeCoreServices({
      ...requiredAdapters(),
      ipc,
      logger: createTestLoggerService(),
      clock: createTestClockService({ now: 5 }),
      platform: createTestPlatformService({ appPlatform: 'ios' }),
    })
    const seen: { source: string; paths: string[] }[] = []
    services.fileChanges.subscribe((batch) => {
      seen.push({ source: batch.source, paths: batch.changes.map((change) => change.path) })
    })
    await expect(internal.noteFile.write('notes/a.md', 'a', 1)).resolves.toEqual({ merged: null })
    expect(seen).toEqual([{ source: 'own-write', paths: ['notes/a.md'] }])
  })

  it('builds the index reads over the composed database', async () => {
    const ipc = createTestIpcBridgeService({
      commands: { db_query: () => [{ path: 'notes/a.md' }] },
    })
    const services = createCoreServices({
      ...requiredAdapters(),
      ipc,
      logger: createTestLoggerService(),
    })
    await expect(services.indexQuery.randomNotePath()).resolves.toBe('notes/a.md')
    expect(ipc.calls().map((call) => call.command)).toEqual(['db_query'])
  })

  it('builds each replaced service with its factory over the same dependencies', () => {
    const noteFile = createTestNoteFileService()
    const received: unknown[] = []
    const { internal } = composeCoreServices(requiredAdapters(), {
      noteFile: () => noteFile,
      noteDocuments: (deps) => {
        received.push(deps.noteFile)
        return createNoteDocumentService(deps)
      },
    })
    expect(internal.noteFile).toBe(noteFile)
    expect(received).toEqual([noteFile])
  })
})

describe('createTestCoreServices', () => {
  it('builds the index reads over the test database and note files', async () => {
    const services = createTestCoreServices()
    seedNotes(services.database, [{ path: 'notes/plan.md', markdown: '# Plan\n' }])
    await services.noteFile.write('notes/plan-2.md', '# Plan\n', 1)

    await expect(services.indexQuery.resolveNoteTarget('plan')).resolves.toBe('notes/plan.md')
    await expect(
      services.search.searchWithFilters(parseSearchQuery('plan')),
    ).resolves.toMatchObject([{ path: 'notes/plan.md' }])
    await expect(services.notePath.slugPathForTitle('notes/new.md', 'Plan')).resolves.toBe(
      'notes/plan-3.md',
    )
  })

  it('builds the index reads over an overriding database', async () => {
    const database = createTestDatabaseService()
    seedNotes(database, [{ path: 'notes/other.md', markdown: '# Other\n' }])
    const services = createTestCoreServices({ database })

    await expect(services.indexQuery.resolveNoteTarget('other')).resolves.toBe('notes/other.md')
  })
})
