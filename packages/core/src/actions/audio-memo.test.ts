import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProvidersState } from '../ai/provider-config'
import { appendToDailyNote, saveAudioMemo, type AudioMemoResume } from './audio-memo'
import { readNote, writeNote } from '../graph/commands'
import { transcribeAudio } from '../ai/transcribe'
import { getSecret } from '../secrets/keychain'

vi.mock('../graph/commands', () => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('../ai/transcribe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/transcribe')>()),
  transcribeAudio: vi.fn(),
}))
vi.mock('../secrets/keychain', () => ({
  getSecret: vi.fn(),
}))

const readNoteMock = vi.mocked(readNote)
const writeNoteMock = vi.mocked(writeNote)
const transcribeMock = vi.mocked(transcribeAudio)
const getSecretMock = vi.mocked(getSecret)

const PROVIDERS: AiProvidersState = {
  providers: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.1', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-openai',
}

const RECORDING: AudioMemoResume & { kind: 'transcribe' } = {
  kind: 'transcribe',
  audio: new Blob(['audio'], { type: 'audio/mp4' }),
  mimeType: 'audio/mp4',
}

function save(payload: AudioMemoResume, providers: AiProvidersState = PROVIDERS) {
  return saveAudioMemo({ payload, providers, date: '2026-06-11', generation: 3 })
}

beforeEach(() => {
  vi.clearAllMocks()
  readNoteMock.mockResolvedValue('morning thoughts\n')
  writeNoteMock.mockResolvedValue(undefined)
  getSecretMock.mockResolvedValue('sk-live-key')
  transcribeMock.mockResolvedValue('memo transcript')
})

describe('saveAudioMemo', () => {
  it('transcribes with the picked entry’s key and appends to the day’s note', async () => {
    const outcome = await save(RECORDING)

    expect(outcome).toEqual({ ok: true, text: 'memo transcript' })
    expect(getSecretMock).toHaveBeenCalledWith('ai-api-key:cfg-openai')
    expect(transcribeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        apiKey: 'sk-live-key',
        audio: RECORDING.audio,
        mimeType: 'audio/mp4',
      }),
    )
    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      'morning thoughts\n\nmemo transcript\n',
      3,
    )
  })

  it('an append payload skips transcription entirely', async () => {
    const outcome = await save({ kind: 'append', text: 'already transcribed' })

    expect(outcome).toEqual({ ok: true, text: 'already transcribed' })
    expect(transcribeMock).not.toHaveBeenCalled()
    expect(getSecretMock).not.toHaveBeenCalled()
  })

  it('reports a missing provider as resumable — a retry sees fixed settings', async () => {
    const outcome = await save(RECORDING, { providers: [], defaultProviderId: null })

    expect(outcome).toEqual({
      ok: false,
      message: 'No OpenAI or Gemini model is configured.',
      resume: RECORDING,
    })
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('reports a missing keychain entry as resumable', async () => {
    getSecretMock.mockResolvedValue(null)

    const outcome = await save(RECORDING)

    expect(outcome).toMatchObject({ ok: false, resume: RECORDING })
    expect(outcome.ok === false && outcome.message).toMatch(/keychain/)
  })

  it('a transcription failure resumes at the transcribe step', async () => {
    transcribeMock.mockRejectedValue({ kind: 'network', message: 'provider down' })

    const outcome = await save(RECORDING)

    expect(outcome).toEqual({ ok: false, message: 'provider down', resume: RECORDING })
  })

  it('an empty transcript is not resumable — retrying silence cannot help', async () => {
    transcribeMock.mockResolvedValue('')

    const outcome = await save(RECORDING)

    expect(outcome).toMatchObject({ ok: false, resume: null })
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('an append failure resumes with the transcript — transcription is never paid twice', async () => {
    writeNoteMock.mockRejectedValue({ kind: 'io', message: 'disk full' })

    const outcome = await save(RECORDING)

    expect(outcome).toEqual({
      ok: false,
      message: 'disk full',
      resume: { kind: 'append', text: 'memo transcript' },
    })
    expect(transcribeMock).toHaveBeenCalledTimes(1)
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
