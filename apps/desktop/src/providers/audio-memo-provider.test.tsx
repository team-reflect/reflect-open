import { act } from '@/test-utils/act.ts'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  audioMemoIdentity,
  audioMemoPartPath,
  type AiProviderConfig,
  type AudioRecorderFinalSegment,
  type GraphInfo,
  AppError,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestSettingsService,
  type TestCoreServices,
} from '@reflect/core/testing'
import { toast } from '@/components/ui/toast.tsx'
import { SidebarProvider, useSidebar } from '@/providers/sidebar-provider.tsx'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { AudioMemoProvider, useAudioMemo } from './audio-memo-provider.tsx'

const GRAPH: GraphInfo = { root: '/notes', name: 'Notes', generation: 3 }

const OPENAI: AiProviderConfig = {
  id: 'cfg-openai',
  provider: 'openai',
  model: 'gpt-5.1',
  keyHint: 'wxyz1',
}
const ANTHROPIC: AiProviderConfig = {
  id: 'claude',
  provider: 'anthropic',
  model: 'claude-fable-5',
  keyHint: 'wxyz1',
}

const RECORDING: AudioRecorderFinalSegment = {
  audio: { kind: 'blob', blob: new Blob(['audio'], { type: 'audio/mp4' }) },
  mimeType: 'audio/mp4',
  sessionStartedMs: 0,
  part: 1,
  end: true,
  durationMs: 4000,
}

/**
 * The test clock starts at the epoch, so the session identity does too.
 */
const FINAL_PATH = audioMemoPartPath(audioMemoIdentity(new Date(0), 'audio/mp4'), 1, true)

async function setup(provider: AiProviderConfig = OPENAI) {
  const settings = createTestSettingsService({
    aiProviders: [provider],
    defaultAiProviderId: provider.id,
  })
  await settings.whenLoaded()
  const app: TestCoreServices = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    settings,
  })
  app.audioRecorder.setStopResult(RECORDING)

  const hook = await renderHookInApp(() => ({ memo: useAudioMemo(), sidebar: useSidebar() }), {
    app,
    graph: GRAPH,
    wrapper: (children: ReactNode) => (
      <SidebarProvider>
        <AudioMemoProvider graph={GRAPH}>{children}</AudioMemoProvider>
      </SidebarProvider>
    ),
  })
  const cancels = (): number => {
    return app.audioRecorder.calls().filter((call) => call.method === 'cancel').length
  }
  return { ...hook, app, cancels }
}

describe('AudioMemoProvider', () => {
  it('opens the session before the first paint and shows its state', async () => {
    const { result } = await setup()

    expect(result.current.memo).toMatchObject({
      phase: 'idle',
      available: true,
      unavailableReason: null,
      pendingCount: 0,
      error: null,
      canRetry: false,
    })
  })

  it('toggle records, then stops and captures the recording into the open graph', async () => {
    const { result, app } = await setup()

    await act(() => {
      result.current.memo.toggle()
    })
    expect(result.current.memo.phase).toBe('recording')

    await act(() => {
      result.current.memo.toggle()
    })
    await vi.waitFor(() => expect(result.current.memo.phase).toBe('idle'))

    expect(app.assetStore.uploads()).toEqual([{ kind: 'path', path: FINAL_PATH, generation: 3 }])
  })

  it('is unavailable without an OpenAI or Gemini model', async () => {
    const { result, app } = await setup(ANTHROPIC)

    expect(result.current.memo.available).toBe(false)
    expect(result.current.memo.unavailableReason).toMatch(/OpenAI or Gemini/)

    await act(() => {
      result.current.memo.toggle()
    })
    expect(result.current.memo.phase).toBe('idle')
    expect(app.audioRecorder.calls().some((call) => call.method === 'start')).toBe(false)
  })

  it('collapsing the sidebar mid-recording stops and saves', async () => {
    const { result, app } = await setup()

    await act(() => {
      result.current.memo.toggle()
    })
    expect(result.current.memo.phase).toBe('recording')

    await act(() => {
      result.current.sidebar.toggleSidebar()
    })

    await vi.waitFor(() => expect(app.assetStore.uploads()).toHaveLength(1))
    expect(result.current.sidebar.collapsed).toBe(true)
  })

  it('collapsing the sidebar during the permission prompt abandons the request', async () => {
    const { result, app, cancels } = await setup()
    app.audioRecorder.holdNextStart()

    await act(() => {
      result.current.memo.toggle()
    })
    expect(result.current.memo.phase).toBe('requesting')
    const before = cancels()

    await act(() => {
      result.current.sidebar.toggleSidebar()
    })

    expect(cancels()).toBe(before + 1)
    expect(result.current.memo.phase).toBe('idle')
    expect(app.assetStore.uploads()).toEqual([])
  })

  it('starting from a collapsed sidebar expands it first, and the recording stays live', async () => {
    const { result } = await setup()
    await act(() => {
      result.current.sidebar.toggleSidebar()
    })
    expect(result.current.sidebar.collapsed).toBe(true)

    await act(() => {
      result.current.memo.toggle()
    })

    expect(result.current.sidebar.collapsed).toBe(false)
    expect(result.current.memo.phase).toBe('recording')
  })

  it('a capture failure while the sidebar is collapsed surfaces through operations', async () => {
    const { result, app } = await setup()
    vi.spyOn(app.assetStore, 'uploadToPath').mockRejectedValue(new AppError('io', 'disk full'))

    await act(() => {
      result.current.memo.toggle()
    })
    await act(() => {
      result.current.sidebar.toggleSidebar()
    })

    await vi.waitFor(() => {
      expect(app.progress.findByLabel('Saving audio memo')).toMatchObject({
        status: 'failed',
        message: 'disk full',
      })
    })
    expect(result.current.memo.error).toBe('disk full')
    expect(result.current.memo.canRetry).toBe(true)
  })

  it('shows the still-recording reminder as a toast, and stopping takes it down', async () => {
    const add = vi.spyOn(toast, 'add').mockReturnValue('audio-memo-reminder')
    const close = vi.spyOn(toast, 'close').mockReturnValue(undefined)
    const { result, app } = await setup()

    await act(() => {
      result.current.memo.toggle()
    })
    app.audioRecorder.emitReminder(30 * 60_000)
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'audio-memo-reminder', title: 'Still recording' }),
    )

    await act(() => {
      result.current.memo.toggle()
    })

    // Left up, it would keep claiming a session is running, and its stop
    // control would land on whatever recording started next.
    expect(close).toHaveBeenCalledWith('audio-memo-reminder')
  })

  it('cancel discards the recording without saving', async () => {
    const { result, app } = await setup()

    await act(() => {
      result.current.memo.toggle()
    })
    await act(() => {
      result.current.memo.cancel()
    })

    expect(result.current.memo.phase).toBe('idle')
    expect(app.assetStore.uploads()).toEqual([])
  })

  it('unmounting closes the session and releases the microphone', async () => {
    const { result, app, unmount } = await setup()
    await act(() => {
      result.current.memo.toggle()
    })
    expect(app.audioRecorder.state()).toBe('recording')

    await unmount()

    expect(app.audioRecorder.state()).toBe('idle')
    // The graph's own lifecycles listen until the graph closes.
    app.graphSession.setGraph(null)
    expect(app.fileChanges.listenerCount().changes).toBe(0)
  })
})
