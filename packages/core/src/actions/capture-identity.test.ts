import { describe, expect, it } from 'vitest'
import { captureFromPath, captureIdentity, isCaptureSpoolPath } from './capture-identity'

/** 2026-06-11 15:30:22.845 local — every derived name is asserted from it. */
const CAPTURED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
const IDENTITY = captureIdentity(CAPTURED_AT, '7c9e6679-7425-40de-944b-e07fc1f90ae7')

describe('captureIdentity', () => {
  it('derives every name from the capture moment (local time) plus the envelope id', () => {
    expect(IDENTITY).toEqual({
      base: 'capture-2026-06-11-153022-845-7c9e',
      date: '2026-06-11',
      notePath: 'notes/capture-2026-06-11-153022-845-7c9e.md',
      assetPath: 'assets/capture-2026-06-11-153022-845-7c9e.jpg',
    })
  })

  it('two envelopes stamped in the same millisecond get distinct identities', () => {
    const other = captureIdentity(CAPTURED_AT, 'ffff0000-0000-4000-8000-000000000001')
    expect(other.base).toBe('capture-2026-06-11-153022-845-ffff')
    expect(other.notePath).not.toBe(IDENTITY.notePath)
  })
})

describe('captureFromPath', () => {
  it('round-trips the identity from the note path', () => {
    expect(captureFromPath(IDENTITY.notePath)).toEqual(IDENTITY)
  })

  it('rejects everything that is not a well-formed capture note', () => {
    expect(captureFromPath('notes/capture-the-flag.md')).toBeNull()
    expect(captureFromPath('notes/capture-2026-06-11-153022-845.md')).toBeNull() // no id suffix
    expect(captureFromPath('notes/capture-2026-13-40-153022-845-7c9e.md')).toBeNull()
    expect(captureFromPath('notes/capture-2026-06-11-993022-845-7c9e.md')).toBeNull()
    expect(captureFromPath('journal/capture-2026-06-11-153022-845-7c9e.md')).toBeNull()
    expect(captureFromPath('notes/audio-memo-2026-06-11-153022-845.md')).toBeNull()
  })
})

describe('isCaptureSpoolPath', () => {
  it('matches only inbox envelopes', () => {
    expect(isCaptureSpoolPath('.reflect/inbox/7c9e6679.json')).toBe(true)
    expect(isCaptureSpoolPath('.reflect/inbox/7c9e6679.jpg')).toBe(false)
    expect(isCaptureSpoolPath('notes/a.json')).toBe(false)
  })
})
