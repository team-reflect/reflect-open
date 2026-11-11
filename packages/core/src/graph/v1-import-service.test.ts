import { describe, expect, it, vi } from 'vitest'
import { createTestClockService } from '../testing/clock.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import type { GraphInfo, GraphImportSummary } from './schemas.ts'
import {
  createV1ImportService,
  IMPORT_PROGRESS_EVENT,
  type V1ImportState,
} from './v1-import-service.ts'
import { sleep, returnNull } from '@ocavue/utils'

const GRAPH: GraphInfo = { root: '/graphs/notes', name: 'Notes', generation: 42 }

function summary(overrides: Partial<GraphImportSummary> = {}): GraphImportSummary {
  return {
    importedFiles: 2,
    skippedFiles: 1,
    downloadedAssets: 0,
    failedAssetDownloads: 0,
    renamedFiles: 0,
    mergedFiles: 0,
    changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
    ...overrides,
  }
}

/**
 * A service whose native import stays pending until `pendingImport` settles.
 */
function setup(options?: { graph?: GraphInfo | null; cancel?: () => Promise<null> }) {
  const pendingImport = Promise.withResolvers<GraphImportSummary>()
  const ipc = createTestIpcBridgeService({
    commands: {
      graph_import_reflect_v1_zip: () => pendingImport.promise,
      graph_import_cancel: options?.cancel ?? returnNull,
    },
  })
  const fileChanges = createTestFileChangeService()
  const clock = createTestClockService({ now: 1_000 })
  const logger = createTestLoggerService()
  const graphSession = createTestGraphSessionService({
    graph: options?.graph === undefined ? GRAPH : options.graph,
  })
  let refreshes = 0
  vi.spyOn(graphSession, 'refreshIndex').mockImplementation(() => {
    refreshes += 1
  })
  const service = createV1ImportService({
    ipc,
    fileChanges,
    graphSession,
    clock,
    logger,
  })
  const states: V1ImportState[] = []
  service.subscribe(() => {
    states.push(service.get())
  })
  return {
    service,
    ipc,
    fileChanges,
    logger,
    pendingImport,
    states,
    refreshes: () => refreshes,
    setGraph: (next: GraphInfo | null) => {
      graphSession.setGraph(next)
    },
    commands: () => ipc.calls().map((call) => call.command),
  }
}

/**
 * Let the import's settle handlers and the listener registration run.
 */
async function settle(): Promise<void> {
  await sleep(0)
}

describe('V1ImportService', () => {
  it('imports through the generation-pinned native command and applies the result', async () => {
    const context = setup()
    expect(context.service.get()).toEqual({ phase: 'idle' })

    context.service.start('/tmp/reflect-v1.zip')

    expect(context.service.get()).toEqual({
      phase: 'running',
      progress: null,
      cancelling: false,
    })
    expect(context.ipc.calls()).toEqual([
      {
        command: 'graph_import_reflect_v1_zip',
        args: { path: '/tmp/reflect-v1.zip', generation: 42 },
      },
    ])

    const result = summary({ mergedFiles: 1, renamedFiles: 1 })
    context.pendingImport.resolve(result)
    await settle()

    expect(context.service.get()).toEqual({ phase: 'done', summary: result })
    // The imported files are this device's own writes, one report per path.
    expect(context.fileChanges.ownWrites()).toEqual([['notes/a.md'], ['daily/2026-07-04.md']])
    expect(context.refreshes()).toBe(1)

    context.service.dismiss()
    expect(context.service.get()).toEqual({ phase: 'idle' })
  })

  it('stops notifying after unsubscribe', () => {
    const context = setup()
    const listener = vi.fn()
    const unlisten = context.service.subscribe(listener)
    unlisten()
    context.service.start('/tmp/reflect-v1.zip')

    expect(listener).not.toHaveBeenCalled()
    expect(context.states).toHaveLength(1)
  })

  it('surfaces validated progress ticks and drops malformed ones', async () => {
    const context = setup()
    context.service.start('/tmp/reflect-v1.zip')
    await settle()

    context.ipc.emit(IMPORT_PROGRESS_EVENT, { stage: 'downloading', done: 1, total: 4 })
    context.ipc.emit(IMPORT_PROGRESS_EVENT, { stage: 'launching', done: 1, total: 4 })

    expect(context.service.get()).toEqual({
      phase: 'running',
      progress: { stage: 'downloading', done: 1, total: 4 },
      cancelling: false,
    })
    expect(context.logger.getErrors().map((entry) => entry.message)).toEqual([
      'invalid import:progress payload:',
    ])
  })

  it('stops following progress once the import settled', async () => {
    const context = setup()
    context.service.start('/tmp/reflect-v1.zip')
    await settle()
    context.pendingImport.resolve(summary())
    await settle()
    const settled = context.states.length

    context.ipc.emit(IMPORT_PROGRESS_EVENT, { stage: 'writing', done: 1, total: 4 })

    expect(context.states).toHaveLength(settled)
    expect(context.service.get().phase).toBe('done')
  })

  it('ignores a second start while one runs', () => {
    const context = setup()
    context.service.start('/tmp/reflect-v1.zip')
    context.service.start('/tmp/other.zip')

    expect(context.commands()).toEqual(['graph_import_reflect_v1_zip'])
  })

  it('ignores a start while no graph is open', () => {
    const context = setup({ graph: null })
    context.service.start('/tmp/reflect-v1.zip')

    expect(context.service.get()).toEqual({ phase: 'idle' })
    expect(context.commands()).toEqual([])
  })

  it('cannot be dismissed while the import runs', () => {
    const context = setup()
    context.service.start('/tmp/reflect-v1.zip')

    context.service.dismiss()

    expect(context.service.get().phase).toBe('running')
  })

  it('cancels the running import once and settles back to idle', async () => {
    const context = setup()
    context.service.cancel() // nothing runs: no native call
    expect(context.commands()).toEqual([])

    context.service.start('/tmp/reflect-v1.zip')
    context.service.cancel()
    context.service.cancel()

    expect(context.commands()).toEqual(['graph_import_reflect_v1_zip', 'graph_import_cancel'])
    expect(context.service.get()).toEqual({
      phase: 'running',
      progress: null,
      cancelling: true,
    })

    context.pendingImport.reject(new Error('import cancelled'))
    await settle()

    expect(context.service.get()).toEqual({ phase: 'idle' })
    expect(context.fileChanges.ownWrites()).toEqual([])
  })

  it('logs a cancel that the native side rejects', async () => {
    const context = setup({ cancel: () => Promise.reject(new Error('bridge down')) })

    context.service.start('/tmp/reflect-v1.zip')
    context.service.cancel()
    await settle()

    expect(context.logger.getWarnings().map((entry) => entry.message)).toEqual([
      'cancelling the import failed:',
    ])
  })

  it('surfaces failures with the native message', async () => {
    const context = setup()
    context.service.start('/tmp/reflect-v1.zip')

    context.pendingImport.reject(new Error('could not read the zip'))
    await settle()

    expect(context.service.get()).toEqual({
      phase: 'failed',
      message: 'could not read the zip',
    })
    expect(context.refreshes()).toBe(0)

    context.service.dismiss()
    expect(context.service.get()).toEqual({ phase: 'idle' })
  })

  it('drops the result when the graph switched mid-import', async () => {
    const context = setup()
    context.service.start('/tmp/reflect-v1.zip')

    context.setGraph({ root: '/graphs/other', name: 'Other', generation: 43 })
    context.pendingImport.resolve(summary())
    await settle()

    expect(context.service.get()).toEqual({ phase: 'idle' })
    expect(context.fileChanges.ownWrites()).toEqual([])
    expect(context.refreshes()).toBe(0)
  })

  it('drops the result when the same graph was reopened mid-import', async () => {
    const context = setup()
    context.service.start('/tmp/reflect-v1.zip')

    context.setGraph({ ...GRAPH, generation: 43 })
    context.pendingImport.resolve(summary())
    await settle()

    expect(context.service.get()).toEqual({ phase: 'idle' })
    expect(context.fileChanges.ownWrites()).toEqual([])
  })

  it('cancels and drops the result when its workspace goes away mid-import', async () => {
    const context = setup()
    const detach = context.service.attach()
    context.service.start('/tmp/reflect-v1.zip')

    detach()
    expect(context.commands()).toEqual(['graph_import_reflect_v1_zip', 'graph_import_cancel'])

    context.pendingImport.resolve(summary())
    await settle()

    expect(context.service.get()).toEqual({ phase: 'idle' })
    expect(context.fileChanges.ownWrites()).toEqual([])
    expect(context.refreshes()).toBe(0)
  })

  it('cancels nothing when its workspace goes away while idle', () => {
    const context = setup()
    context.service.attach()()

    expect(context.commands()).toEqual([])
  })
})
