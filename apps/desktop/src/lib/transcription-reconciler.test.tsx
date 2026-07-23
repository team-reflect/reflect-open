import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiProvidersState,
  FileChange,
  ReconcileAudioMemosInput,
  ReconcileAudioMemosOutcome,
} from '@reflect/core'
import {
  createTranscriptionReconciler,
  type TranscriptionReconciler,
} from './transcription-reconciler'

const reconcileAudioMemos = vi.hoisted(() =>
  vi.fn<(input: ReconcileAudioMemosInput) => Promise<ReconcileAudioMemosOutcome>>(),
)
const subscribeFileChanges = vi.hoisted(() =>
  vi.fn<(handler: (changes: FileChange[]) => void) => Promise<() => void>>(),
)
const failOperation = vi.hoisted(() => vi.fn<(message: string) => void>())

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  reconcileAudioMemos,
  subscribeFileChanges,
  hasBridge: () => true,
}))
vi.mock('@/lib/provider-fetch', () => ({
  providerFetch: vi.fn(),
}))
vi.mock('@/lib/operations', () => ({
  startOperation: () => ({ progress: vi.fn(), done: vi.fn(), fail: failOperation }),
}))

const PROVIDERS: AiProvidersState = {
  providers: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.1', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-openai',
}
const NO_PROVIDERS: AiProvidersState = { providers: [], defaultProviderId: null }

const DRAINED: ReconcileAudioMemosOutcome = {
  pending: 0,
  transcribed: 0,
  rejected: 0,
  stopped: null,
}

const MEMO_PATH = 'audio-memos/audio-memo-2026-06-12-153022-845.m4a'

let onFileChanges: ((changes: FileChange[]) => void) | null = null
const unlisten = vi.fn()
let reconciler: TranscriptionReconciler | null = null

function create(
  providers: AiProvidersState = PROVIDERS,
  getTranscriptionFormat: () => boolean = () => true,
): TranscriptionReconciler {
  reconciler = createTranscriptionReconciler({
    generation: 3,
    getProviders: () => providers,
    getTranscriptionFormat,
  })
  return reconciler
}

/** Settle the microtask chain a resolved pass runs on. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  onFileChanges = null
  reconcileAudioMemos.mockResolvedValue(DRAINED)
  subscribeFileChanges.mockImplementation(async (handler) => {
    onFileChanges = handler
    return unlisten
  })
})

afterEach(() => {
  reconciler?.dispose()
  reconciler = null
})

describe('createTranscriptionReconciler', () => {
  it('start runs the launch pass with the lazily-read models, pinned to the generation', async () => {
    create().start()
    await flush()

    expect(reconcileAudioMemos).toHaveBeenCalledTimes(1)
    expect(reconcileAudioMemos).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: PROVIDERS,
        generation: 3,
        formatTranscript: true,
      }),
    )
  })

  it('reads the formatting preference lazily for every pass', async () => {
    let formatTranscript = true
    const subject = create(PROVIDERS, () => formatTranscript)
    subject.start()
    await flush()

    expect(reconcileAudioMemos).toHaveBeenLastCalledWith(
      expect.objectContaining({ formatTranscript: true }),
    )

    formatTranscript = false
    subject.schedule()
    await flush()

    expect(reconcileAudioMemos).toHaveBeenLastCalledWith(
      expect.objectContaining({ formatTranscript: false }),
    )
  })

  it('gates every pass on a transcription-capable model — no IO without one', async () => {
    create(NO_PROVIDERS).start()
    await flush()

    window.dispatchEvent(new Event('focus'))
    onFileChanges?.([{ path: MEMO_PATH, kind: 'upsert' }])
    await flush()

    expect(reconcileAudioMemos).not.toHaveBeenCalled()
  })

  it('coalesces triggers landing mid-pass into exactly one follow-up', async () => {
    let release: (outcome: ReconcileAudioMemosOutcome) => void = () => {}
    reconcileAudioMemos.mockImplementationOnce(
      () =>
        new Promise<ReconcileAudioMemosOutcome>((resolve) => {
          release = resolve
        }),
    )
    const subject = create()
    subject.start()
    await flush()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(1)

    // Three triggers while the pass runs — one follow-up, not three.
    subject.schedule()
    subject.schedule()
    window.dispatchEvent(new Event('online'))
    release(DRAINED)
    await flush()

    expect(reconcileAudioMemos).toHaveBeenCalledTimes(2)
  })

  it('retries on focus and online, and on watcher-reported recordings only', async () => {
    create().start()
    await flush()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(2)

    window.dispatchEvent(new Event('online'))
    await flush()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(3)

    onFileChanges?.([{ path: MEMO_PATH, kind: 'upsert' }])
    await flush()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(4)

    // Note edits and recording removals ride the same stream — no pass.
    onFileChanges?.([{ path: 'notes/some-note.md', kind: 'upsert' }])
    onFileChanges?.([{ path: MEMO_PATH, kind: 'remove' }])
    await flush()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(4)
  })

  it('retries when the app becomes visible again (the iOS foreground signal)', async () => {
    const subject = create()
    subject.start()
    await flush()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(1)

    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(2)

    subject.dispose()
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(2) // listener removed on dispose
  })

  it('exposes the transcribing flag while a pass has memos, and notifies subscribers', async () => {
    let release: (outcome: ReconcileAudioMemosOutcome) => void = () => {}
    reconcileAudioMemos.mockImplementationOnce(
      (input) =>
        new Promise<ReconcileAudioMemosOutcome>((resolve) => {
          input.onPending?.(2)
          release = resolve
        }),
    )
    const subject = create()
    const notifications = vi.fn()
    subject.subscribe(notifications)
    subject.start()
    await flush()

    expect(subject.getTranscribing()).toBe(true)
    expect(notifications).toHaveBeenCalledTimes(1)

    release({ pending: 2, transcribed: 2, rejected: 0, stopped: null })
    await flush()
    expect(subject.getTranscribing()).toBe(false)
    expect(notifications).toHaveBeenCalledTimes(2)
  })

  it('surfaces a stop that needs attention once, deduped across retries', async () => {
    reconcileAudioMemos.mockResolvedValue({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'auth', message: 'openai rejected the API key (401)' },
    })
    create().start()
    await flush()
    expect(failOperation).toHaveBeenCalledWith('openai rejected the API key (401)')

    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(2)
    expect(failOperation).toHaveBeenCalledTimes(1)
  })

  it('keeps expected stops silent — offline heals on the next trigger', async () => {
    reconcileAudioMemos.mockResolvedValue({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'network', message: 'provider down' },
    })
    create().start()
    await flush()

    expect(reconcileAudioMemos).toHaveBeenCalled()
    expect(failOperation).not.toHaveBeenCalled()
  })

  it('dispose detaches every trigger and flips the pass abort gate', async () => {
    let staleGate: (() => boolean) | undefined
    reconcileAudioMemos.mockImplementation(async (input) => {
      staleGate = input.isStale
      return DRAINED
    })
    const subject = create()
    subject.start()
    await flush()
    expect(staleGate?.()).toBe(false)

    subject.dispose()
    expect(unlisten).toHaveBeenCalled()
    expect(staleGate?.()).toBe(true)

    window.dispatchEvent(new Event('focus'))
    onFileChanges?.([{ path: MEMO_PATH, kind: 'upsert' }])
    await flush()
    expect(reconcileAudioMemos).toHaveBeenCalledTimes(1)
  })
})
