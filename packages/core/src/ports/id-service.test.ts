import { isValid } from 'ulid'
import { describe, expect, it } from 'vitest'
import { createTestIdService } from '../testing/index.ts'
import { createSystemIdService } from './id-service.ts'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NOTE_ID_RE = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/
describe('createSystemIdService', () => {
  it('returns v4 UUIDs', () => {
    const id = createSystemIdService()
    const a = id.uuid()
    expect(a).toMatch(UUID_V4_RE)
    expect(id.uuid()).not.toBe(a)
  })

  it('returns lowercase ULID note ids', () => {
    const id = createSystemIdService()
    const a = id.noteId()
    expect(isValid(a)).toBe(true)
    expect(a).toMatch(NOTE_ID_RE)
    expect(id.noteId()).not.toBe(a)
  })
})
describe('createTestIdService', () => {
  it('counts UUIDs up from one', () => {
    const id = createTestIdService()
    expect(id.uuid()).toBe('00000000-0000-4000-8000-000000000001')
    expect(id.uuid()).toBe('00000000-0000-4000-8000-000000000002')
    expect(id.uuid()).toMatch(UUID_V4_RE)
  })

  it('returns valid, monotonic, deterministic note ids', () => {
    const a = createTestIdService()
    const b = createTestIdService()
    const ids = Array.from({ length: 40 }, () => a.noteId())
    expect(ids.map(() => b.noteId())).toEqual(ids)
    for (const value of ids) {
      expect(isValid(value)).toBe(true)
      expect(value).toMatch(NOTE_ID_RE)
    }
    expect(ids.toSorted()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('separates seeds', () => {
    const a = createTestIdService({ seed: 'a' })
    const b = createTestIdService({ seed: 'b' })
    expect(a.uuid()).not.toBe(b.uuid())
    expect(a.noteId()).not.toBe(b.noteId())
    expect(a.uuid()).toMatch(UUID_V4_RE)
    expect(isValid(a.noteId())).toBe(true)
  })

  it('records issued ids', () => {
    const id = createTestIdService()
    const uuid = id.uuid()
    const noteId = id.noteId()
    expect(id.issued()).toEqual([uuid, noteId])
  })
})
