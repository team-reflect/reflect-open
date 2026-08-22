import { describe, expect, it } from 'vitest'
import { chunkAssetDescriptionsWithAttribution } from '../../embeddings/chunk'
import type { RetrievalHit } from '../../embeddings/retrieve'
import { resolveSearchHitsForChat } from './search-hit-privacy'

const NOTE_PATH = 'notes/board.md'
const PRIVATE_PATH = 'notes/private.md'
const ASSET_PATH = 'assets/chart.png'
const SIDECAR_PATH = 'assets/chart.png.reflect.md'
const QUERY = 'quasar-budget-sentinel'
const PUBLIC_NOTE = `# Board\n\n![chart](${ASSET_PATH})\n`
const PRIVATE_NOTE = `---\nprivate: true\n---\n# Private\n\n![chart](${ASSET_PATH})\n`
const DESCRIPTION = `${QUERY} appears only in the attachment description.`

async function retrievalHit(kind: 'lexical' | 'semantic'): Promise<RetrievalHit> {
  if (kind === 'lexical') {
    return {
      path: NOTE_PATH,
      title: 'Indexed board title',
      score: 1,
      snippet: `stored snippet containing ${DESCRIPTION}`,
      heading: null,
      isPrivate: false,
      evidence: { kind: 'lexical', assetPaths: [ASSET_PATH] },
    }
  }
  const [chunk] = await chunkAssetDescriptionsWithAttribution(
    [{ assetPath: ASSET_PATH, body: DESCRIPTION }],
    PUBLIC_NOTE.length + 1,
  )
  if (chunk === undefined) {
    throw new Error('expected an asset chunk')
  }
  return {
    path: NOTE_PATH,
    title: 'Indexed board title',
    score: 1,
    snippet: chunk.text,
    heading: chunk.heading,
    isPrivate: false,
    evidence: {
      kind: 'semantic',
      assetPaths: [ASSET_PATH],
      posFrom: chunk.posFrom,
      posTo: chunk.posTo,
      contentHash: chunk.contentHash,
    },
  }
}

function deps(includePrivateReference: boolean) {
  const files: Record<string, string> = {
    [NOTE_PATH]: PUBLIC_NOTE,
    [PRIVATE_PATH]: PRIVATE_NOTE,
    [SIDECAR_PATH]: DESCRIPTION,
  }
  return {
    readNoteFn: async (path: string) => {
      const source = files[path]
      if (source === undefined) {
        throw { kind: 'notFound', message: 'missing' }
      }
      return source
    },
    assetReferencingNotePathsFn: async () =>
      includePrivateReference ? [NOTE_PATH, PRIVATE_PATH] : [NOTE_PATH],
  }
}

describe('resolveSearchHitsForChat asset privacy', () => {
  it.each(['lexical', 'semantic'] as const)(
    'drops an initially private %s asset hit before any description or title is sent',
    async (kind) => {
      const result = await resolveSearchHitsForChat(QUERY, [await retrievalHit(kind)], deps(true))

      expect(result).toEqual({ hits: [], attributions: [] })
      expect(JSON.stringify(result)).not.toContain(QUERY)
      expect(JSON.stringify(result)).not.toContain('Indexed board title')
    },
  )

  it.each(['lexical', 'semantic'] as const)(
    'keeps a live-sendable %s asset hit with explicit asset attribution',
    async (kind) => {
      const result = await resolveSearchHitsForChat(QUERY, [await retrievalHit(kind)], deps(false))

      expect(result.hits).toHaveLength(1)
      expect(result.hits[0]).toMatchObject({ path: NOTE_PATH, title: 'Board' })
      expect(result.attributions).toEqual([{ notePath: NOTE_PATH, assetPaths: [ASSET_PATH] }])
      if (kind === 'lexical') {
        expect(result.hits[0]?.snippet).toBe('')
      } else {
        expect(result.hits[0]?.snippet).toContain(QUERY)
      }
    },
  )

  it('drops a stale lexical hit instead of reusing a stored combined-FTS snippet', async () => {
    const hit = await retrievalHit('lexical')
    const result = await resolveSearchHitsForChat('no-live-match', [hit], deps(false))

    expect(result.hits).toEqual([])
    expect(JSON.stringify(result)).not.toContain(DESCRIPTION)
  })
})
