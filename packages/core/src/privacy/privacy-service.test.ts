import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { describe, expect, it } from 'vitest'
import type { RetrievalHit } from '../embeddings/retrieval-service.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import {
  assertCloudAllowed,
  cloudSafeAssetDescription,
  cloudSafeLinkHref,
  cloudSafeNoteContent,
  cloudSafeSelection,
  createPrivacyService,
  isPrivateNoteError,
  notePrivate,
  PrivateNoteError,
} from './privacy-service.ts'

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

describe('cloudSafeLinkHref', () => {
  it('mints a public note link destination', () => {
    expect(cloudSafeLinkHref({ path: 'notes/a.md', isPrivate: false }, 'https://example.com')).toBe(
      'https://example.com',
    )
  })

  it('refuses a private note before the destination can be fetched', () => {
    expect(() => {
      return cloudSafeLinkHref({ path: PRIVATE_PATH, isPrivate: true }, 'https://example.com')
    }).toThrow(PrivateNoteError)
  })
})

describe('notePrivate', () => {
  it('reads the shared privacy flag from full note source', () => {
    expect(notePrivate('---\nprivate: true\n---\nsecret')).toBe(true)
    expect(notePrivate('---\nprivate: false\n---\npublic')).toBe(false)
    expect(notePrivate('no frontmatter')).toBe(false)
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

function setup(files: Record<string, string>) {
  const noteFile = createTestNoteFileService({ files })
  return {
    noteFile,
    privacy: createPrivacyService({
      noteFile,
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    }),
  }
}

describe('isPrivateLive', () => {
  it('reads the flag from the note on disk', async () => {
    const { privacy } = setup({
      'notes/a.md': '# Public\n',
      [PRIVATE_PATH]: '---\nprivate: true\n---\n# Diary\n',
    })

    await expect(privacy.isPrivateLive('notes/a.md')).resolves.toBe(false)
    await expect(privacy.isPrivateLive(PRIVATE_PATH)).resolves.toBe(true)
  })

  it('fails closed when the note cannot be read', async () => {
    const { privacy } = setup({})

    await expect(privacy.isPrivateLive('notes/missing.md')).resolves.toBe(true)
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

  it('drops private hits entirely: not even the title survives', async () => {
    const { privacy } = setup({ 'notes/a.md': '# Public\n', [PRIVATE_PATH]: '# Diary\n' })

    const safe = await privacy.cloudSafeSearchHits([PUBLIC, PRIVATE])
    const payload = JSON.stringify(safe)
    expect(payload).not.toContain(PRIVATE_TITLE)
    expect(payload).not.toContain(PRIVATE_PATH)
    expect(safe).toEqual([{ path: 'notes/a.md', title: 'Public', snippet: 'body', heading: null }])
  })

  it('drops hits the live probe flags even when the index lags (TOCTOU)', async () => {
    const { privacy } = setup({
      'notes/a.md': '# Public\n',
      [PRIVATE_PATH]: '---\nprivate: true\n---\n# Diary\n',
    })
    // The stale index still says public.
    const justMarkedPrivate: RetrievalHit = { ...PRIVATE, isPrivate: false }

    const safe = await privacy.cloudSafeSearchHits([PUBLIC, justMarkedPrivate])
    const payload = JSON.stringify(safe)
    expect(payload).not.toContain(PRIVATE_TITLE)
    expect(payload).not.toContain(PRIVATE_PATH)
    expect(safe).toHaveLength(1)
  })

  it('drops a hit whose note cannot be read', async () => {
    const { privacy } = setup({})

    await expect(privacy.cloudSafeSearchHits([PUBLIC])).resolves.toEqual([])
  })

  it('never probes hits the index already flags private', async () => {
    const { privacy, noteFile } = setup({ 'notes/a.md': '# Public\n' })

    await privacy.cloudSafeSearchHits([PUBLIC, PRIVATE])
    expect(noteFile.getReads().map((read) => read.path)).toEqual(['notes/a.md'])
  })

  it('strips hits to the cloud-facing fields (no score, no flag)', async () => {
    const { privacy } = setup({ 'notes/a.md': '# Public\n' })

    const [hit] = await privacy.cloudSafeSearchHits([PUBLIC])
    expect(Object.keys(hit ?? {}).sort()).toEqual(['heading', 'path', 'snippet', 'title'])
  })
})

describe('cloudSafeNoteListings', () => {
  const listing = {
    title: 'Public',
    dailyDate: null,
    snippet: 'body',
    modifiedAt: '2026-06-12T00:00:00.000Z',
  }

  it('keeps public entries and drops indexed or live private ones', async () => {
    const { privacy } = setup({
      'notes/a.md': '# Public\n',
      'notes/b.md': '---\nprivate: true\n---\n# Diary\n',
    })

    const safe = await privacy.cloudSafeNoteListings([
      { ...listing, path: 'notes/a.md', isPrivate: false },
      { ...listing, path: 'notes/b.md', isPrivate: false },
      { ...listing, path: PRIVATE_PATH, isPrivate: true, title: PRIVATE_TITLE },
      { ...listing, path: 'notes/missing.md', isPrivate: false },
    ])
    expect(JSON.stringify(safe)).not.toContain(PRIVATE_TITLE)
    expect(safe).toEqual([{ ...listing, path: 'notes/a.md' }])
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
    expect(() => {
      return cloudSafeNoteContent({
        path: PRIVATE_PATH,
        isPrivate: true,
        title: PRIVATE_TITLE,
        content: PRIVATE_BODY,
        truncated: false,
      })
    }).toThrow(PrivateNoteError)
  })
})

describe('cloudSafeAssetDescription', () => {
  it('mints a description for a sendable asset', () => {
    expect(
      cloudSafeAssetDescription({
        path: 'assets/chart.png',
        isPrivate: false,
        description: 'A bar chart of Q4 revenue.',
        truncated: false,
      }),
    ).toEqual({
      path: 'assets/chart.png',
      description: 'A bar chart of Q4 revenue.',
      truncated: false,
    })
  })

  it('refuses to mint a blocked asset before any description escapes', () => {
    expect(() => {
      return cloudSafeAssetDescription({
        path: 'assets/secret.png',
        isPrivate: true,
        description: PRIVATE_BODY,
        truncated: false,
      })
    }).toThrow(PrivateNoteError)
  })
})

describe('cloudSafeSelection', () => {
  it('mints a selection from a non-private note', () => {
    expect(cloudSafeSelection({ path: 'notes/a.md', isPrivate: false }, 'selected text')).toBe(
      'selected text',
    )
  })

  it('refuses to mint a selection from a private note', () => {
    expect(() => cloudSafeSelection({ path: PRIVATE_PATH, isPrivate: true }, PRIVATE_BODY)).toThrow(
      PrivateNoteError,
    )
  })
})
