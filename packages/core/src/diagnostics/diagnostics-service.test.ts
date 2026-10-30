import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import {
  createTestAppInfoService,
  createTestEmbeddingRuntimeService,
  createTestGraphSessionService,
  createTestNoteFileService,
  createTestSettingsService,
} from '../testing/index.ts'
import { overrideNoteFileService } from '../testing/graph.ts'
import { createDiagnosticsService } from './diagnostics-service.ts'

describe('createDiagnosticsService', () => {
  it('reports integrations and the graph size', async () => {
    const settings = createTestSettingsService({
      semanticSearchEnabled: true,
      calendarEnabled: true,
    })
    await settings.reload()
    const noteFile = createTestNoteFileService({
      files: {
        'small.md': 'x'.repeat(2 * 1024),
        'large.md': 'x'.repeat(3 * 1024 * 1024),
        'assets/a.png': 'x'.repeat(5 * 1024),
      },
    })
    const diagnostics = createDiagnosticsService({
      appInfo: createTestAppInfoService('1.2.3'),
      embeddingRuntime: createTestEmbeddingRuntimeService(),
      graphSession: createTestGraphSessionService({ graph: {} }),
      noteFile,
      settings,
    })

    expect((await diagnostics.collect()).split('\n')).toEqual([
      'Version: 1.2.3',
      'OS: test test',
      'Main process memory: unknown',
      'Uptime: 0:00',
      'Semantic search: on, model all-MiniLM-L6-v2 loaded',
      'Calendar: on',
      'Contacts: off',
      'Git backup: off',
      'Notes: 2, 3 MB in total, largest 3 MB',
      'Attachments: 1, 5 KB in total, largest 5 KB',
    ])
  })

  it('reports a fact that fails as unavailable and keeps the rest', async () => {
    const noteFile = overrideNoteFileService(createTestNoteFileService(), {
      listNotes: () => Promise.reject(new AppError('io', 'catalog busy')),
    })
    const diagnostics = createDiagnosticsService({
      appInfo: createTestAppInfoService(),
      embeddingRuntime: createTestEmbeddingRuntimeService(),
      graphSession: createTestGraphSessionService({ graph: {} }),
      noteFile,
      settings: createTestSettingsService(),
    })

    const lines = (await diagnostics.collect()).split('\n')

    expect(lines).toContain('Notes: unavailable (catalog busy)')
    expect(lines).toContain('Attachments: 0')
  })
})
