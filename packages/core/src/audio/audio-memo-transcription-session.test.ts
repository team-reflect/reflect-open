import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { audioMemoIdentity } from './audio-memo.ts'
import type { FileMeta } from '../graph/schemas.ts'
import { AUDIO_MEMOS_DIR } from '../graph/paths.ts'
import {
  createAudioMemoTestKit,
  MEMO,
  NO_PROVIDERS,
  type AudioMemoTestKit,
  type AudioMemoTestKitOptions,
} from './audio-memo-test-kit.ts'
import type { AudioMemoTranscriptionSession } from './audio-memo-transcription-service.ts'

const LATER = audioMemoIdentity(new Date(2026, 5, 12, 9, 0, 0, 0), 'audio/mp4')

let session: AudioMemoTranscriptionSession | null = null

async function open(options?: AudioMemoTestKitOptions): Promise<{
  kit: AudioMemoTestKit
  subject: AudioMemoTranscriptionSession
  /**
   * How many passes got past the config gate.
   */
  passes: () => number
}> {
  const kit = await createAudioMemoTestKit(options)
  const listDirMock = vi.spyOn(kit.noteFile, 'listDir')
  const subject = kit.service.openSession({ generation: 3 })
  session = subject
  return { kit, subject, passes: () => listDirMock.mock.calls.length }
}

/**
 * Settle the microtask chain a resolved pass runs on.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  session?.dispose()
  session = null
})

describe('AudioMemoTranscriptionService.openSession', () => {
  it('start runs the launch pass, pinned to the generation', async () => {
    const { kit, subject } = await open()
    const listDirMock = vi.spyOn(kit.noteFile, 'listDir')

    subject.start()
    await flush()

    expect(listDirMock.mock.calls).toEqual([[AUDIO_MEMOS_DIR, 3]])
  })

  it('reads the formatting preference at the start of every pass', async () => {
    const { kit, subject } = await open()
    kit.addRecording(MEMO.audioPath)
    subject.start()
    await flush()

    expect(kit.enrichMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ formatTranscript: true }),
    )

    kit.settings.update({ transcriptionFormat: false })
    kit.addRecording(LATER.audioPath)
    subject.schedule()
    await flush()

    expect(kit.enrichMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ formatTranscript: false }),
    )
  })

  it('reads the transcription hint at the start of every pass', async () => {
    const { kit, subject } = await open()
    kit.addRecording(MEMO.audioPath)
    subject.start()
    await flush()
    expect(kit.transcription.calls().at(-1)?.prompt).toBe('')

    kit.settings.update({ transcriptionPrompt: 'Names: Ocavue' })
    kit.addRecording(LATER.audioPath)
    subject.schedule()
    await flush()
    expect(kit.transcription.calls().at(-1)?.prompt).toBe('Names: Ocavue')
  })

  it('gates every pass on a transcription-capable model — no IO without one', async () => {
    const { kit, subject, passes } = await open({ providers: NO_PROVIDERS })
    subject.start()
    await flush()

    kit.activity.emitWake()
    kit.fileChanges.emit({
      changes: [{ path: MEMO.audioPath, kind: 'upsert' }],
      source: 'external',
    })
    await flush()

    expect(passes()).toBe(0)
  })

  it('coalesces triggers landing mid-pass into exactly one follow-up', async () => {
    const { kit, subject } = await open()
    const pending = Promise.withResolvers<FileMeta[]>()
    const listDirMock = vi
      .spyOn(kit.noteFile, 'listDir')
      .mockImplementationOnce(() => pending.promise)
    subject.start()
    await flush()
    expect(listDirMock).toHaveBeenCalledTimes(1)

    // Three triggers while the pass runs — one follow-up, not three.
    subject.schedule()
    subject.schedule()
    kit.activity.emitWake()
    pending.resolve([])
    await flush()

    expect(listDirMock).toHaveBeenCalledTimes(2)
  })

  it('retries on wake, and on watcher-reported recordings only', async () => {
    const { kit, subject, passes } = await open()
    subject.start()
    await flush()
    expect(passes()).toBe(1)

    kit.activity.emitWake()
    await flush()
    expect(passes()).toBe(2)

    kit.fileChanges.emit({
      changes: [{ path: MEMO.audioPath, kind: 'upsert' }],
      source: 'external',
    })
    await flush()
    expect(passes()).toBe(3)

    // Note edits and recording removals ride the same stream — no pass.
    kit.fileChanges.emit({
      changes: [{ path: 'notes/some-note.md', kind: 'upsert' }],
      source: 'external',
    })
    kit.fileChanges.emit({
      changes: [{ path: MEMO.audioPath, kind: 'remove' }],
      source: 'external',
    })
    await flush()
    expect(passes()).toBe(3)
  })

  it('retries when the app becomes visible again (the iOS foreground signal)', async () => {
    const { kit, subject, passes } = await open()
    subject.start()
    await flush()
    expect(passes()).toBe(1)

    kit.activity.emitVisible()
    await flush()
    expect(passes()).toBe(2)

    subject.dispose()
    kit.activity.emitVisible()
    await flush()
    expect(passes()).toBe(2) // listener removed on dispose
  })

  it('exposes the transcribing flag while a pass has memos, and notifies subscribers', async () => {
    const { kit, subject } = await open()
    kit.addRecording(MEMO.audioPath)
    const provider = Promise.withResolvers<string>()
    kit.transcription.setResult(() => provider.promise)
    const notifications = vi.fn()
    subject.subscribe(notifications)
    subject.start()
    await flush()

    expect(subject.getTranscribing()).toBe(true)
    expect(notifications).toHaveBeenCalledTimes(1)

    provider.resolve('memo transcript')
    await flush()
    expect(subject.getTranscribing()).toBe(false)
    expect(notifications).toHaveBeenCalledTimes(2)
  })

  it('surfaces a stop that needs attention once, deduped across retries', async () => {
    const { kit, subject } = await open()
    kit.addRecording(MEMO.audioPath)
    kit.transcription.setResult(() =>
      Promise.reject(new AppError('auth', 'openai rejected the API key (401)')),
    )
    subject.start()
    await flush()
    expect(kit.progress.findByLabel('Transcribing audio memo')).toMatchObject({
      status: 'failed',
      message: 'openai rejected the API key (401)',
    })

    kit.activity.emitWake()
    await flush()
    expect(kit.transcription.calls()).toHaveLength(2)
    expect(kit.progress.getAll()).toHaveLength(1)
  })

  it('keeps expected stops silent — offline heals on the next trigger', async () => {
    const { kit, subject } = await open()
    kit.addRecording(MEMO.audioPath)
    kit.transcription.setResult(() => Promise.reject(new AppError('network', 'provider down')))
    subject.start()
    await flush()

    expect(kit.transcription.calls()).toHaveLength(1)
    expect(kit.progress.getAll()).toEqual([])
  })

  it('dispose detaches every trigger and flips the pass abort gate', async () => {
    const { kit, subject, passes } = await open()
    kit.addRecording(MEMO.audioPath)
    subject.start()
    await flush()
    const staleGate = kit.transcription.calls()[0]?.isStale
    expect(staleGate?.()).toBe(false)
    expect(passes()).toBe(1)

    subject.dispose()
    expect(kit.fileChanges.listenerCount().changes).toBe(0)
    expect(staleGate?.()).toBe(true)

    kit.activity.emitWake()
    kit.fileChanges.emit({
      changes: [{ path: MEMO.audioPath, kind: 'upsert' }],
      source: 'external',
    })
    await flush()
    expect(passes()).toBe(1)
  })
})
