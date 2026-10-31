import { describe, expect, it } from 'vitest'
import {
  audioMemoFromPath,
  audioMemoIdentity,
  audioMemoPartFromPath,
  audioMemoPartPath,
} from './audio-memo.ts'

/**
 * 2026-06-11 15:30:22.845 local — every derived name is asserted from it.
 */
const RECORDED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
const MEMO = audioMemoIdentity(RECORDED_AT, 'audio/webm;codecs=opus')

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

  it('parses a part number that outgrew three digits', () => {
    const path = 'audio-memos/audio-memo-2026-06-11-153022-845.part-1000.webm'
    expect(audioMemoPartFromPath(path)).toEqual({ memo: MEMO, part: 1000, end: false })
    expect(audioMemoPartPath(MEMO, 1000, false)).toBe(path)
  })

  it('rejects everything that is not a well-formed memo recording', () => {
    expect(audioMemoFromPath('audio-memos/voice-note.mp3')).toBeNull()
    expect(audioMemoFromPath('audio-memos/audio-memo-2026-13-40-153022-845.webm')).toBeNull()
    expect(audioMemoFromPath('audio-memos/audio-memo-2026-06-11-993022-845.webm')).toBeNull()
    expect(audioMemoFromPath('assets/audio-memo-2026-06-11-153022-845.webm')).toBeNull()
    expect(audioMemoFromPath('notes/audio-memo-2026-06-11-153022-845.md')).toBeNull()
  })
})
