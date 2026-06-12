import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiModelsState } from '../ai/models'
import {
  appendToDailyNote,
  audioMemoFromPath,
  audioMemoIdentity,
  captureAudioMemo,
  reconcileAudioMemos,
  type ReconcileAudioMemosInput,
} from './audio-memo'
import {
  listDir,
  listFiles,
  readAsset,
  readNote,
  writeAsset,
  writeNote,
} from '../graph/commands'
import { transcribeAudio, TranscriptionRejectedError } from '../ai/transcribe'
import { getSecret } from '../secrets/keychain'

vi.mock('../graph/commands', () => ({
  listDir: vi.fn(),
  listFiles: vi.fn(),
  readAsset: vi.fn(),
  readNote: vi.fn(),
  writeAsset: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('../ai/transcribe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/transcribe')>()),
  transcribeAudio: vi.fn(),
}))
vi.mock('../secrets/keychain', () => ({
  getSecret: vi.fn(),
}))

const listDirMock = vi.mocked(listDir)
const listFilesMock = vi.mocked(listFiles)
const readAssetMock = vi.mocked(readAsset)
const readNoteMock = vi.mocked(readNote)
const writeAssetMock = vi.mocked(writeAsset)
const writeNoteMock = vi.mocked(writeNote)
const transcribeMock = vi.mocked(transcribeAudio)
const getSecretMock = vi.mocked(getSecret)

const MODELS: AiModelsState = {
  models: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.1', keyHint: 'wxyz1' }],
  defaultModelId: 'cfg-openai',
}

/** 2026-06-11 15:30:22.845 local — every derived name is asserted from it. */
const RECORDED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
const MEMO = audioMemoIdentity(RECORDED_AT, 'audio/webm;codecs=opus')

function fileMeta(path: string): { path: string; size: number; modifiedMs: number } {
  return { path, size: 1, modifiedMs: 0 }
}

function reconcile(overrides: Partial<ReconcileAudioMemosInput> = {}) {
  return reconcileAudioMemos({ models: MODELS, generation: 3, ...overrides })
}

beforeEach(() => {
  vi.clearAllMocks()
  listDirMock.mockResolvedValue([])
  listFilesMock.mockResolvedValue([])
  readAssetMock.mockResolvedValue(btoa('audio-bytes'))
  readNoteMock.mockResolvedValue('morning thoughts\n')
  writeAssetMock.mockResolvedValue(undefined)
  writeNoteMock.mockResolvedValue(undefined)
  getSecretMock.mockResolvedValue('sk-live-key')
  transcribeMock.mockResolvedValue('memo transcript')
})

describe('audioMemoIdentity', () => {
  it('derives every name from the recording moment, in local time', () => {
    expect(MEMO).toEqual({
      base: 'audio-memo-2026-06-11-153022-845',
      date: '2026-06-11',
      title: 'Audio memo 2026-06-11 15:30:22',
      alias: 'Audio memo 15:30',
      audioPath: 'audio-memos/audio-memo-2026-06-11-153022-845.webm',
      notePath: 'notes/audio-memo-2026-06-11-153022-845.md',
      mimeType: 'audio/webm',
    })
  })

  it('stores an audio-only MP4 as .m4a — whisper sniffs by extension', () => {
    const memo = audioMemoIdentity(RECORDED_AT, 'audio/mp4')
    expect(memo.audioPath).toBe('audio-memos/audio-memo-2026-06-11-153022-845.m4a')
    expect(memo.mimeType).toBe('audio/mp4')
  })
})

describe('audioMemoFromPath', () => {
  it('round-trips the identity from the recording path', () => {
    expect(audioMemoFromPath(MEMO.audioPath)).toEqual(MEMO)
  })

  it('rejects everything that is not a well-formed memo recording', () => {
    expect(audioMemoFromPath('audio-memos/voice-note.mp3')).toBeNull()
    expect(audioMemoFromPath('audio-memos/audio-memo-2026-13-40-153022-845.webm')).toBeNull()
    expect(audioMemoFromPath('audio-memos/audio-memo-2026-06-11-993022-845.webm')).toBeNull()
    expect(audioMemoFromPath('assets/audio-memo-2026-06-11-153022-845.webm')).toBeNull()
    expect(audioMemoFromPath('notes/audio-memo-2026-06-11-153022-845.md')).toBeNull()
  })
})

describe('captureAudioMemo', () => {
  it('writes the recording base64-encoded under audio-memos/, pinned to the generation', async () => {
    const outcome = await captureAudioMemo({
      audio: new Blob(['audio'], { type: 'audio/webm' }),
      mimeType: 'audio/webm;codecs=opus',
      recordedAt: RECORDED_AT,
      generation: 3,
    })

    expect(outcome).toEqual({ ok: true, memo: MEMO })
    expect(writeAssetMock).toHaveBeenCalledWith(MEMO.audioPath, btoa('audio'), 3)
  })

  it('reports a write failure as data — the caller retries with the same recording', async () => {
    writeAssetMock.mockRejectedValue({ kind: 'io', message: 'disk full' })

    const outcome = await captureAudioMemo({
      audio: new Blob(['audio'], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      recordedAt: RECORDED_AT,
      generation: 3,
    })

    expect(outcome).toEqual({ ok: false, message: 'disk full' })
  })
})

describe('reconcileAudioMemos', () => {
  it('does nothing when every memo already has its transcription note', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    listFilesMock.mockResolvedValue([fileMeta(MEMO.notePath)])

    const onPending = vi.fn()
    const outcome = await reconcile({ onPending })

    expect(outcome).toEqual({ pending: 0, transcribed: 0, rejected: 0, stopped: null })
    expect(onPending).toHaveBeenCalledWith(0)
    expect(transcribeMock).not.toHaveBeenCalled()
    expect(getSecretMock).not.toHaveBeenCalled()
  })

  it('ignores stray files in audio-memos/ that are not memo recordings', async () => {
    listDirMock.mockResolvedValue([fileMeta('audio-memos/voice-note.mp3')])

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 0, transcribed: 0, rejected: 0, stopped: null })
    expect(transcribeMock).not.toHaveBeenCalled()
  })

  it('transcribes a pending memo, writes the note, then backlinks the daily note', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(getSecretMock).toHaveBeenCalledWith('ai-api-key:cfg-openai')
    expect(readAssetMock).toHaveBeenCalledWith(MEMO.audioPath)
    expect(transcribeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        apiKey: 'sk-live-key',
        mimeType: 'audio/webm',
      }),
    )
    const sent = transcribeMock.mock.calls[0]?.[0].audio
    expect(new TextDecoder().decode(await sent?.arrayBuffer())).toBe('audio-bytes')
    // The note lands first — it carries the transcript; the backlink follows.
    expect(writeNoteMock.mock.calls).toEqual([
      [
        MEMO.notePath,
        '# Audio memo 2026-06-11 15:30:22\n\n[Recording](audio-memos/audio-memo-2026-06-11-153022-845.webm)\n\nmemo transcript\n',
        3,
      ],
      [
        'daily/2026-06-11.md',
        'morning thoughts\n\n[[Audio memo 2026-06-11 15:30:22|Audio memo 15:30]]\n',
        3,
      ],
    ])
  })

  it('a provider-refused recording is tombstoned with a failure note; the pass continues', async () => {
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath), fileMeta(earlier.audioPath)])
    transcribeMock
      .mockRejectedValueOnce(
        new TranscriptionRejectedError('openai rejected the recording (413): too large'),
      )
      .mockResolvedValueOnce('second transcript')

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 2, transcribed: 1, rejected: 1, stopped: null })
    expect(writeNoteMock).toHaveBeenCalledWith(
      earlier.notePath,
      expect.stringContaining(
        'Transcription failed: openai rejected the recording (413): too large',
      ),
      3,
    )
    expect(writeNoteMock).toHaveBeenCalledWith(
      MEMO.notePath,
      expect.stringContaining('second transcript'),
      3,
    )
  })

  it('a failed note write stops before the backlink — the transcript is never tombstoned away', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    writeNoteMock.mockRejectedValue({ kind: 'io', message: 'disk full' })

    const outcome = await reconcile()

    expect(outcome).toEqual({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'io', message: 'disk full' },
    })
    // Only the note write was attempted: no backlink means no tombstone, so
    // the next pass retries this memo instead of dropping its transcript.
    expect(writeNoteMock).toHaveBeenCalledTimes(1)
    expect(writeNoteMock.mock.calls[0]?.[0]).toBe(MEMO.notePath)
  })

  it('creates the daily note when the day has none yet', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    readNoteMock.mockRejectedValue({ kind: 'notFound', message: 'no such note' })

    await reconcile()

    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      '[[Audio memo 2026-06-11 15:30:22|Audio memo 15:30]]\n',
      3,
    )
  })

  it('a daily-note backlink without the note is a tombstone — deletion stays deleted', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    readNoteMock.mockResolvedValue(
      'notes\n\n[[Audio memo 2026-06-11 15:30:22|Audio memo 15:30]]\n',
    )

    const onPending = vi.fn()
    const outcome = await reconcile({ onPending })

    expect(outcome).toEqual({ pending: 0, transcribed: 0, rejected: 0, stopped: null })
    expect(onPending).toHaveBeenCalledWith(0)
    expect(transcribeMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('an empty transcript writes a placeholder note — silence must not retry forever', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    transcribeMock.mockResolvedValue('')

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(writeNoteMock).toHaveBeenCalledWith(
      MEMO.notePath,
      expect.stringContaining('No speech detected.'),
      3,
    )
  })

  it('transcribes oldest first, regardless of listing order', async () => {
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath), fileMeta(earlier.audioPath)])

    await reconcile()

    expect(readAssetMock.mock.calls.map(([path]) => path)).toEqual([
      earlier.audioPath,
      MEMO.audioPath,
    ])
  })

  it('stops the pass on the first failure — the rest would fail the same way', async () => {
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    listDirMock.mockResolvedValue([fileMeta(earlier.audioPath), fileMeta(MEMO.audioPath)])
    transcribeMock.mockRejectedValue({ kind: 'network', message: 'provider down' })

    const outcome = await reconcile()

    expect(outcome).toEqual({
      pending: 2,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'network', message: 'provider down' },
    })
    expect(transcribeMock).toHaveBeenCalledTimes(1)
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('reports a missing provider as config — the pass retries after settings change', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])

    const outcome = await reconcile({ models: { models: [], defaultModelId: null } })

    expect(outcome).toMatchObject({
      pending: 1,
      transcribed: 0,
      stopped: { reason: 'config' },
    })
    expect(getSecretMock).not.toHaveBeenCalled()
  })

  it('reports a missing keychain entry as config', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    getSecretMock.mockResolvedValue(null)

    const outcome = await reconcile()

    expect(outcome).toMatchObject({ pending: 1, stopped: { reason: 'config' } })
    expect(outcome.stopped?.message).toMatch(/keychain/)
    expect(transcribeMock).not.toHaveBeenCalled()
  })

  it('the abort gate stops between memos', async () => {
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    listDirMock.mockResolvedValue([fileMeta(earlier.audioPath), fileMeta(MEMO.audioPath)])
    const isStale = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)

    const outcome = await reconcile({ isStale })

    expect(outcome).toMatchObject({
      pending: 2,
      transcribed: 1,
      stopped: { reason: 'stale' },
    })
    expect(transcribeMock).toHaveBeenCalledTimes(1)
  })

  it('a listing failure is reported, never thrown — reconcile runs unattended', async () => {
    listDirMock.mockRejectedValue({ kind: 'noGraph', message: 'no graph open' })

    const outcome = await reconcile()

    expect(outcome).toEqual({
      pending: 0,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'noGraph', message: 'no graph open' },
    })
  })
})

describe('appendToDailyNote', () => {
  it('appends to the existing daily note, pinned to the generation', async () => {
    await appendToDailyNote({ date: '2026-06-11', text: 'memo text', generation: 7 })

    expect(readNoteMock).toHaveBeenCalledWith('daily/2026-06-11.md')
    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      'morning thoughts\n\nmemo text\n',
      7,
    )
  })

  it('creates the note when the day has none yet', async () => {
    readNoteMock.mockRejectedValue({ kind: 'notFound', message: 'no such note' })

    await appendToDailyNote({ date: '2026-06-11', text: 'memo text', generation: 7 })

    expect(writeNoteMock).toHaveBeenCalledWith('daily/2026-06-11.md', 'memo text\n', 7)
  })

  it('rethrows read failures other than notFound and never writes', async () => {
    readNoteMock.mockRejectedValue({ kind: 'io', message: 'disk gone' })

    await expect(
      appendToDailyNote({ date: '2026-06-11', text: 'memo text', generation: 7 }),
    ).rejects.toMatchObject({ kind: 'io' })
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid date before any file access', async () => {
    await expect(
      appendToDailyNote({ date: 'not-a-date', text: 'memo text', generation: 7 }),
    ).rejects.toThrow()
    expect(readNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })
})
