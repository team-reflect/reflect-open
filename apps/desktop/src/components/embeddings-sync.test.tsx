import { describe, expect, it, vi } from 'vitest'
import { createTestCoreServices, createTestSettingsService } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { EmbeddingsSync } from './embeddings-sync.tsx'

// The sync itself is `SemanticSearchService.start`, covered in `@reflect/core`.

describe('EmbeddingsSync', () => {
  it('runs the semantic search service for as long as it is mounted', async () => {
    const view = await renderInApp(<EmbeddingsSync />, { servicesOnly: true })
    expect(view.app.semanticSearch.running()).toBe(1)

    await view.unmount()
    expect(view.app.semanticSearch.running()).toBe(0)
  })

  it('backfills and follows the open graph while enabled and ready', async () => {
    const settings = createTestSettingsService({ semanticSearchEnabled: true })
    await settings.whenLoaded()
    const app = createTestCoreServices({ database: createWasmTestDatabaseService(), settings })
    app.graphSession.setState({
      graph: { root: '/g', name: 'g', generation: 1 },
      indexGeneration: 7,
    })

    await renderInApp(<EmbeddingsSync />, { app, servicesOnly: true })

    await vi.waitFor(() => {
      expect(app.embeddingIndex.follows()).toEqual([{ generation: 7, modelId: 'all-MiniLM-L6-v2' }])
    })
  })

  it('starts no embedding work while semantic search is disabled', async () => {
    const view = await renderInApp(<EmbeddingsSync />, { servicesOnly: true })
    view.app.graphSession.setState({
      graph: { root: '/g', name: 'g', generation: 1 },
      indexGeneration: 7,
    })
    await vi.waitFor(() => expect(view.app.embeddingRuntime.lastStatus().status).toBe('ready'))

    expect(view.app.embeddingRuntime.ensureCalls()).toBe(0)
    expect(view.app.embeddingIndex.follows()).toEqual([])
  })
})
