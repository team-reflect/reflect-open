import { beforeEach, describe, expect, it } from 'vitest'
import { createTestClockService } from '../testing/clock.ts'
import { createTestFileChangeService, type TestFileChangeService } from '../testing/file-change.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestIpcBridgeService, type TestIpcBridgeService } from '../testing/ipc.ts'
import {
  createConflictArchiveService,
  type ConflictArchiveService,
} from './conflict-archive-service.ts'

const PATH = 'notes/a.md'
const VERSION = {
  name: '1700000000000-phone.md',
  modifiedMs: 1700000000000,
  device: 'phone',
  size: 5,
}

let ipc: TestIpcBridgeService
let fileChanges: TestFileChangeService
let service: ConflictArchiveService

beforeEach(() => {
  ipc = createTestIpcBridgeService({
    commands: {
      conflict_archive_list: () => [VERSION],
      conflict_archive_read: () => 'older',
      conflict_archive_restore: () => ({ modifiedMs: 1700000000500 }),
    },
  })
  fileChanges = createTestFileChangeService({ echoOwnWrites: true })
  service = createConflictArchiveService({
    ipc,
    clock: createTestClockService(),
    fileChanges,
    graphSession: createTestGraphSessionService({ graph: { generation: 3, indexGeneration: 7 } }),
  })
})

describe('ConflictArchiveService', () => {
  it('lists the archived versions of a note', async () => {
    expect(await service.list(PATH)).toEqual([VERSION])
    expect(ipc.calls()).toEqual([
      { command: 'conflict_archive_list', args: { path: PATH, generation: 3 } },
    ])
  })

  it('reads one archived version by name', async () => {
    expect(await service.read(PATH, VERSION.name)).toBe('older')
    expect(ipc.calls()).toEqual([
      {
        command: 'conflict_archive_read',
        args: { path: PATH, name: VERSION.name, generation: 3 },
      },
    ])
  })

  it('restores a version through the native command and reports the write', async () => {
    await service.restore(PATH, VERSION.name)
    expect(ipc.calls()).toEqual([
      {
        command: 'conflict_archive_restore',
        args: { path: PATH, name: VERSION.name, generation: 3 },
      },
    ])
    expect(fileChanges.batches()).toEqual([
      {
        changes: [{ path: PATH, kind: 'upsert', modifiedMs: 1700000000500 }],
        source: 'own-write',
      },
    ])
  })
})
