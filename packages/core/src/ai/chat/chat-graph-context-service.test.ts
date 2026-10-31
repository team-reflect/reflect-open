import { createTestGraphSessionService } from '../../testing/graph-session.ts'
import { describe, expect, it } from 'vitest'
import type { GraphStatsOptions } from '../../indexing/graph-stats-service.ts'
import { createPrivacyService } from '../../privacy/privacy-service.ts'
import { createTestNoteFileService } from '../../testing/index.ts'
import { createChatGraphContextService, MAX_CONTEXT_TAGS } from './chat-graph-context-service.ts'

describe('ChatGraphContextService', () => {
  it('loads stats at the prompt tag cap and stamps the graph name on them', async () => {
    const seen: GraphStatsOptions[] = []
    const service = createChatGraphContextService({
      graphStats: {
        loadGraphStats: (options) => {
          seen.push(options)
          return {
            noteCount: 7,
            dailyNoteCount: 2,
            earliestDailyDate: '2026-06-01',
            latestDailyDate: '2026-06-10',
            tags: [{ tag: 'book', count: 2 }],
            tagsTruncated: false,
          }
        },
      },
      privacy: createPrivacyService({
        noteFile: createTestNoteFileService(),
        graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
      }),
    })

    const context = await service.load('atlas-graph')

    expect(seen).toEqual([{ tagLimit: MAX_CONTEXT_TAGS }])
    expect(context).toEqual({
      graphName: 'atlas-graph',
      noteCount: 7,
      dailyNoteCount: 2,
      earliestDailyDate: '2026-06-01',
      latestDailyDate: '2026-06-10',
      tags: [{ tag: 'book', count: 2 }],
      tagsTruncated: false,
    })
  })
})
