import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProvidersState } from '../ai/provider-config'
import {
  audioMemoFromPath,
  audioMemoIdentity,
  captureAudioMemo,
  isSilentStop,
  reconcileAudioMemos,
  type ReconcileAudioMemosInput,
  type ReconcileStop,
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

const PROVIDERS: AiProvidersState = {
  providers: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.1', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-openai',
}

/** 2026-06-11 15:30:22.845 local — every derived name is asserted from it. */
const RECORDED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
const MEMO = audioMemoIdentity(RECORDED_AT, 'audio/webm;codecs=opus')

function fileMeta(path: string): { path: string; size: number; modifiedMs: number } {
  return { path, size: 1, modifiedMs: 0 }
}

function reconcile(overrides: Partial<ReconcileAudioMemosInput> = {}) {
  return reconcileAudioMemos({ providers: PROVIDERS, generation: 3, ...overrides })
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
    expect(readAssetMock).toHaveBeenCalledWith(MEMO.audioPath, 3)
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
    // The link targets the base (unique per recording), resolved through the
    // note's frontmatter alias; the title alone repeats within a second.
    expect(writeNoteMock.mock.calls).toEqual([
      [
        MEMO.notePath,
        '---\naliases: [audio-memo-2026-06-11-153022-845]\n---\n\n# Audio memo 2026-06-11 15:30:22\n\n[Recording](audio-memos/audio-memo-2026-06-11-153022-845.webm)\n\nmemo transcript\n',
        3,
      ],
      [
        'daily/2026-06-11.md',
        'morning thoughts\n\n[[audio-memo-2026-06-11-153022-845|Audio memo 15:30]]\n',
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
      '[[audio-memo-2026-06-11-153022-845|Audio memo 15:30]]\n',
      3,
    )
  })

  it('a daily-note backlink without the note is a tombstone — deletion stays deleted', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    readNoteMock.mockResolvedValue(
      'notes\n\n[[audio-memo-2026-06-11-153022-845|Audio memo 15:30]]\n',
    )

    const onPending = vi.fn()
    const outcome = await reconcile({ onPending })

    expect(outcome).toEqual({ pending: 0, transcribed: 0, rejected: 0, stopped: null })
    expect(onPending).toHaveBeenCalledWith(0)
    expect(transcribeMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('a same-second sibling backlink is not this memo\'s tombstone', async () => {
    // Same second, different milliseconds: identical display titles, distinct
    // bases. The earlier sibling is fully done; the later one must still run.
    const sibling = audioMemoIdentity(new Date(2026, 5, 11, 15, 30, 22, 100), 'audio/webm')
    listDirMock.mockResolvedValue([fileMeta(sibling.audioPath), fileMeta(MEMO.audioPath)])
    listFilesMock.mockResolvedValue([fileMeta(sibling.notePath)])
    readNoteMock.mockResolvedValue(`notes\n\n[[${sibling.base}|Audio memo 15:30]]\n`)

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(writeNoteMock).toHaveBeenCalledWith(
      MEMO.notePath,
      expect.stringContaining('memo transcript'),
      3,
    )
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

  it('a memo that failed to transcribe drains on the next pass — e.g. the next app launch', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    transcribeMock.mockRejectedValueOnce({ kind: 'network', message: 'offline' })

    const offline = await reconcile()

    expect(offline).toMatchObject({ pending: 1, transcribed: 0, stopped: { reason: 'network' } })
    expect(writeNoteMock).not.toHaveBeenCalled()

    // Nothing about the pending memo lives in memory: a later pass — the next
    // trigger, or the mount pass after an app restart — recomputes it from
    // the same on-disk state and drains it.
    const relaunched = await reconcile()

    expect(relaunched).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(writeNoteMock).toHaveBeenCalledWith(
      MEMO.notePath,
      expect.stringContaining('memo transcript'),
      3,
    )
    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      expect.stringContaining('[[audio-memo-2026-06-11-153022-845|Audio memo 15:30]]'),
      3,
    )
  })

  it('reports a missing provider as config — the pass retries after settings change', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])

    const outcome = await reconcile({ providers: { providers: [], defaultProviderId: null } })

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
    // The gate is consulted three times per memo (loop top, post-read,
    // post-transcribe): let the first memo through, stop the second.
    const isStale = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true)

    const outcome = await reconcile({ isStale })

    expect(outcome).toMatchObject({
      pending: 2,
      transcribed: 1,
      stopped: { reason: 'stale' },
    })
    expect(transcribeMock).toHaveBeenCalledTimes(1)
  })

  it('a graph switch during transcription stops before any write', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    let closed = false
    transcribeMock.mockImplementation(async () => {
      closed = true // the switch lands while the provider call is in flight
      return 'memo transcript'
    })

    const outcome = await reconcile({ isStale: () => closed })

    expect(outcome).toMatchObject({
      pending: 1,
      transcribed: 0,
      stopped: { reason: 'stale' },
    })
    expect(writeNoteMock).not.toHaveBeenCalled()
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

describe('reconcileAudioMemos daily-note handling', () => {
  it('rethrows daily-note read failures other than notFound — never writes blind', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    readNoteMock.mockRejectedValue({ kind: 'io', message: 'disk gone' })

    const outcome = await reconcile()

    expect(outcome).toMatchObject({ stopped: { reason: 'io', message: 'disk gone' } })
    expect(writeNoteMock).not.toHaveBeenCalled()
  })
})

describe('isSilentStop', () => {
  const stop = (reason: ReconcileStop['reason']): ReconcileStop => ({ reason, message: reason })

  it('treats the self-healing reasons as silent', () => {
    expect(isSilentStop(stop('network'))).toBe(true)
    expect(isSilentStop(stop('config'))).toBe(true)
    expect(isSilentStop(stop('stale'))).toBe(true)
  })

  it('treats unexpected reasons as worth surfacing', () => {
    expect(isSilentStop(stop('auth'))).toBe(false)
    expect(isSilentStop(stop('io'))).toBe(false)
    expect(isSilentStop(stop('unknown'))).toBe(false)
  })
})
