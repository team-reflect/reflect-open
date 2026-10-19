import { expect, it, vi } from 'vitest'
import { createTestCoreServices, createTestEmbeddingRuntimeService } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useEmbedStatus } from './use-embed-status.ts'

it('starts a later mount from the last status an earlier mount received', async () => {
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    embeddingRuntime: createTestEmbeddingRuntimeService({ status: { status: 'unsupported' } }),
  })
  const first = await renderHookInApp(() => useEmbedStatus(), { app })
  await vi.waitFor(() => expect(first.result.current).toEqual({ status: 'unsupported' }))
  await first.unmount()

  const seen: string[] = []
  await renderHookInApp(
    () => {
      const status = useEmbedStatus()
      seen.push(status.status)
      return status
    },
    { app },
  )

  expect(seen[0]).toBe('unsupported')
})

it('tracks status changes while mounted', async () => {
  const runtime = createTestEmbeddingRuntimeService({ status: { status: 'loading' } })
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    embeddingRuntime: runtime,
  })
  const view = await renderHookInApp(() => useEmbedStatus(), { app })
  await vi.waitFor(() => expect(view.result.current).toEqual({ status: 'loading' }))

  runtime.setStatus({ status: 'ready', model: 'all-MiniLM-L6-v2' })
  await vi.waitFor(() => {
    expect(view.result.current).toEqual({ status: 'ready', model: 'all-MiniLM-L6-v2' })
  })
})
