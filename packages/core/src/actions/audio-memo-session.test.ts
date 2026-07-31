import { describe, expect, it } from 'vitest'
import { audioMemoPartFromPath, audioMemoPartPath, audioMemoIdentity } from './audio-memo'
import {
  AUDIO_MEMO_SEGMENT_MS,
  decodePartResult,
  encodePartResult,
  groupAudioMemoSessions,
  isSessionClosed,
  isSessionReady,
  partTranscriptName,
  stitchSessionTranscript,
  type AudioMemoPart,
} from './audio-memo-session'

const MEMO = audioMemoIdentity(new Date(2026, 5, 11, 15, 30, 22, 845), 'audio/mp4')
const OTHER = audioMemoIdentity(new Date(2026, 5, 11, 16, 0, 0, 0), 'audio/mp4')

function part(overrides: Partial<AudioMemoPart>): AudioMemoPart {
  const partNumber = overrides.part ?? 1
  const end = overrides.end ?? false
  return {
    memo: MEMO,
    path: audioMemoPartPath(MEMO, partNumber, end),
    part: partNumber,
    end,
    placeholder: false,
    sizeBytes: 1024,
    modifiedMs: 1_000_000,
    ...overrides,
  }
}

describe('audioMemoPartFromPath', () => {
  it('parses a segment path with its position and end marker', () => {
    expect(audioMemoPartFromPath(audioMemoPartPath(MEMO, 2, false))).toMatchObject({
      memo: { base: MEMO.base },
      part: 2,
      end: false,
    })
    expect(audioMemoPartFromPath(audioMemoPartPath(MEMO, 3, true))).toMatchObject({
      part: 3,
      end: true,
    })
  })

  it('reads a legacy suffix-free recording as a one-part closed session', () => {
    expect(audioMemoPartFromPath(MEMO.audioPath)).toMatchObject({
      memo: { base: MEMO.base },
      part: 1,
      end: true,
    })
  })

  it('rejects a zero part number and malformed paths', () => {
    expect(audioMemoPartFromPath(`audio-memos/${MEMO.base}.part-000.m4a`)).toBeNull()
    expect(audioMemoPartFromPath('audio-memos/notes.m4a')).toBeNull()
  })
})

describe('groupAudioMemoSessions', () => {
  it('groups by session base, parts ordered, oldest session first', () => {
    const otherPart: AudioMemoPart = {
      ...part({}),
      memo: OTHER,
      path: audioMemoPartPath(OTHER, 1, true),
      end: true,
    }
    const sessions = groupAudioMemoSessions([
      part({ part: 2 }),
      otherPart,
      part({ part: 1 }),
      part({ part: 3, end: true }),
    ])
    expect(sessions.map((session) => session.memo.base)).toEqual([MEMO.base, OTHER.base])
    expect(sessions[0]!.parts.map((entry) => entry.part)).toEqual([1, 2, 3])
  })
})

describe('session close and readiness', () => {
  const now = 10_000_000

  it('closes on the end marker regardless of age', () => {
    const session = { memo: MEMO, parts: [part({ modifiedMs: now, end: true })] }
    expect(isSessionClosed(session, now)).toBe(true)
  })

  it('closes by age when a crash lost the end marker', () => {
    const fresh = { memo: MEMO, parts: [part({ modifiedMs: now - AUDIO_MEMO_SEGMENT_MS })] }
    expect(isSessionClosed(fresh, now)).toBe(false)
    const stale = { memo: MEMO, parts: [part({ modifiedMs: now - 3 * AUDIO_MEMO_SEGMENT_MS })] }
    expect(isSessionClosed(stale, now)).toBe(true)
  })

  it('is not ready with a gap in the part sequence', () => {
    const session = { memo: MEMO, parts: [part({ part: 1 }), part({ part: 3, end: true })] }
    expect(isSessionReady(session, now)).toBe(false)
  })

  it('is not ready while a segment is an eviction placeholder', () => {
    const session = {
      memo: MEMO,
      parts: [part({ part: 1, placeholder: true }), part({ part: 2, end: true })],
    }
    expect(isSessionReady(session, now)).toBe(false)
  })

  it('is ready when closed and gap-free', () => {
    const session = { memo: MEMO, parts: [part({ part: 1 }), part({ part: 2, end: true })] }
    expect(isSessionReady(session, now)).toBe(true)
  })
})

describe('transcript cache codec', () => {
  it('round-trips both result shapes and rejects junk', () => {
    expect(decodePartResult(encodePartResult({ text: 'hello' }))).toEqual({ text: 'hello' })
    expect(decodePartResult(encodePartResult({ rejected: 'bad container' }))).toEqual({
      rejected: 'bad container',
    })
    expect(decodePartResult('not json')).toBeNull()
    expect(decodePartResult('{"other": 1}')).toBeNull()
  })

  it('names the cache entry after the segment file', () => {
    expect(partTranscriptName(part({ part: 2 }))).toBe(`${MEMO.base}.part-002.m4a.json`)
  })
})

describe('stitchSessionTranscript', () => {
  it('keeps the single-part wording of pre-segmentation notes', () => {
    expect(stitchSessionTranscript([{ text: 'hello' }])).toBe('hello')
    expect(stitchSessionTranscript([{ rejected: 'bad bytes' }])).toBe(
      'Transcription failed: bad bytes',
    )
  })

  it('joins parts as paragraphs and turns a rejected part into one line', () => {
    expect(
      stitchSessionTranscript([{ text: 'first' }, { rejected: 'bad bytes' }, { text: 'third' }]),
    ).toBe('first\n\nPart 2 transcription failed: bad bytes\n\nthird')
  })

  it('drops empty segments instead of stacking blank paragraphs', () => {
    expect(stitchSessionTranscript([{ text: 'first' }, { text: '' }, { text: 'third' }])).toBe(
      'first\n\nthird',
    )
  })
})
