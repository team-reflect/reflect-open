import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { isNotNullish } from '@ocavue/utils'
import { generateText, streamText } from '@reflect/modules/ai'
import { describe, expect, it } from 'vitest'
import type { AiProviderConfig } from '../settings/schema.ts'
import { APP_REVIEW_STUB_KEY, createDemoModel, DEMO_REPLY_TEXT } from './app-review-demo.ts'
import {
  createNodeTestDatabaseService,
  createTestHttpService,
  createTestLoggerService,
  createTestNoteFileService,
  createTestRetrievalService,
  createTestXArchiveService,
} from '../testing/index.ts'
import { createAssetPrivacyService } from '../assets/asset-privacy-service.ts'
import { createPrivacyService } from '../privacy/privacy-service.ts'
import { createNoteListService } from '../indexing/note-list-service.ts'
import { createNoteToolsService } from './chat/note-tools-service.ts'
import { createChatEngineService, type ChatStreamEvent } from './chat/chat-engine-service.ts'
import { fitToContextWindow } from './chat/context-window.ts'
import { createLanguageModelService, createLazyAiSdkLoader } from './language-model-service.ts'

describe('createDemoModel', () => {
  it('generates the demo reply without any transport', async () => {
    const result = await generateText({
      model: createDemoModel(),
      prompt: 'hello',
      maxRetries: 0,
    })
    expect(result.text).toBe(DEMO_REPLY_TEXT)
  })

  it('streams the demo reply word by word', async () => {
    const result = streamText({
      model: createDemoModel(),
      prompt: 'hello',
      maxRetries: 0,
    })
    let text = ''
    for await (const delta of result.textStream) {
      text += delta
    }
    expect(text).toBe(DEMO_REPLY_TEXT)
  })

  it('carries a full chat turn end to end without fetching', async () => {
    const config: AiProviderConfig = {
      id: 'cfg-demo',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      keyHint: 'demo1',
    }
    const events: ChatStreamEvent[] = []
    // No route answers: any request the demo sent would fail the turn.
    const http = createTestHttpService()
    const noteFile = createTestNoteFileService()
    const xArchive = createTestXArchiveService()
    const assetReferences = { notePaths: () => [] }
    const engine = createChatEngineService({
      logger: createTestLoggerService(),
      languageModel: createLanguageModelService({ http, sdk: createLazyAiSdkLoader() }),
      noteTools: createNoteToolsService({
        retrieval: createTestRetrievalService(),
        noteFile,
        noteList: createNoteListService({ database: createNodeTestDatabaseService() }),
        dailyNotes: { listDailyNotes: () => [] },
        assetReferences,
        assetPrivacy: createAssetPrivacyService({ noteFile, xArchive, assetReferences }),
        xArchive,
        privacy: createPrivacyService({
          noteFile,
          graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
        }),
      }),
      fitToContextWindow,
    })
    const turn = engine.streamTurn({
      config,
      apiKey: APP_REVIEW_STUB_KEY,
      messages: [{ role: 'user', content: 'What is in my notes?' }],
      today: '2026-08-14',
      semanticSearchEnabled: false,
      generation: 1,
      customSystemPrompt: '',
      context: null,
    })
    for await (const event of turn) {
      events.push(event)
    }
    const text = events
      .map((event) => (event.type === 'text-delta' ? event.text : null))
      .filter(isNotNullish)
      .join('')
    expect(text).toBe(DEMO_REPLY_TEXT)
    expect(events.at(-1)?.type).toBe('complete')
    expect(http.requests()).toEqual([])
  })
})
