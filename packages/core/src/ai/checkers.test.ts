import { describe, expect, it } from 'vitest'
import type { RetrievalHit } from '../embeddings/retrieve'
import {
  assertCloudAllowed,
  cloudSafeNoteContent,
  cloudSafeSearchHits,
  cloudSafeSelection,
  isPrivateNoteError,
  PrivateNoteError,
} from './checkers'

// Sentinels no other string in the system (prompts included) can collide
// with — a payload assertion against them can never pass vacuously.
const PRIVATE_TITLE = 'sentinel-title-01jxq3'
const PRIVATE_PATH = 'notes/sentinel-path-01jxq3.md'
const PRIVATE_BODY = 'sentinel-body-01jxq3'

describe('assertCloudAllowed', () => {
  it('passes a non-private note through', () => {
    expect(() => assertCloudAllowed({ path: 'notes/a.md', isPrivate: false })).not.toThrow()
  })

  it('throws PrivateNoteError for a private note', () => {
    expect(() => assertCloudAllowed({ path: 'notes/secret.md', isPrivate: true })).toThrow(
      PrivateNoteError,
    )
  })
})

describe('isPrivateNoteError', () => {
  it('recognizes the thrown refusal', () => {
    try {
      assertCloudAllowed({ path: 'notes/secret.md', isPrivate: true })
      expect.unreachable('should have thrown')
    } catch (cause) {
      expect(isPrivateNoteError(cause)).toBe(true)
    }
  })

  it('rejects other errors', () => {
    expect(isPrivateNoteError(new Error('boom'))).toBe(false)
    expect(isPrivateNoteError(null)).toBe(false)
  })
})

describe('cloudSafeSearchHits', () => {
  const PUBLIC: RetrievalHit = {
    path: 'notes/a.md',
    title: 'Public',
    score: 1,
    snippet: 'body',
    heading: null,
    isPrivate: false,
  }
  const PRIVATE: RetrievalHit = {
    path: PRIVATE_PATH,
    title: PRIVATE_TITLE,
    score: 0.9,
    snippet: '',
    heading: null,
    isPrivate: true,
  }

  const neverPrivate = async () => false

  it('drops private hits entirely — not even the title survives', async () => {
    const safe = await cloudSafeSearchHits([PUBLIC, PRIVATE], neverPrivate)
    const payload = JSON.stringify(safe)
    expect(payload).not.toContain(PRIVATE_TITLE)
    expect(payload).not.toContain(PRIVATE_PATH)
    expect(safe).toEqual([{ path: 'notes/a.md', title: 'Public', snippet: 'body', heading: null }])
  })

  it('drops hits the live probe flags even when the index lags (TOCTOU)', async () => {
    const justMarkedPrivate: RetrievalHit = {
      ...PRIVATE,
      isPrivate: false, // the stale index still says public
    }
    const safe = await cloudSafeSearchHits(
      [PUBLIC, justMarkedPrivate],
      async (path) => path === PRIVATE_PATH,
    )
    const payload = JSON.stringify(safe)
    expect(payload).not.toContain(PRIVATE_TITLE)
    expect(payload).not.toContain(PRIVATE_PATH)
    expect(safe).toHaveLength(1)
  })

  it('never probes hits the index already flags private', async () => {
    const probed: string[] = []
    await cloudSafeSearchHits([PUBLIC, PRIVATE], async (path) => {
      probed.push(path)
      return false
    })
    expect(probed).toEqual(['notes/a.md'])
  })

  it('strips hits to the cloud-facing fields (no score, no flag)', async () => {
    const [hit] = await cloudSafeSearchHits([PUBLIC], neverPrivate)
    expect(Object.keys(hit ?? {}).sort()).toEqual(['heading', 'path', 'snippet', 'title'])
  })
})

describe('cloudSafeNoteContent', () => {
  it('mints content for a non-private note', () => {
    expect(
      cloudSafeNoteContent({
        path: 'notes/a.md',
        isPrivate: false,
        title: 'A',
        content: 'body',
        truncated: false,
      }),
    ).toEqual({ path: 'notes/a.md', title: 'A', content: 'body', truncated: false })
  })

  it('refuses to mint a private note before any content escapes', () => {
    expect(() =>
      cloudSafeNoteContent({
        path: PRIVATE_PATH,
        isPrivate: true,
        title: PRIVATE_TITLE,
        content: PRIVATE_BODY,
        truncated: false,
      }),
    ).toThrow(PrivateNoteError)
  })
})

describe('cloudSafeSelection', () => {
  it('mints a selection from a non-private note', () => {
    expect(cloudSafeSelection({ path: 'notes/a.md', isPrivate: false }, 'selected text')).toBe(
      'selected text',
    )
  })

  it('refuses to mint a selection from a private note', () => {
    expect(() =>
      cloudSafeSelection({ path: PRIVATE_PATH, isPrivate: true }, PRIVATE_BODY),
    ).toThrow(PrivateNoteError)
  })
})
