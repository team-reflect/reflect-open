import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { rebuildAssetSearchIndex, reconcileAssetSearch } from './asset-search'

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

const managedSidecar = [
  '---',
  'reflectAssetDescription: 1',
  'source: assets/photo.png',
  'sourceHash: source-hash',
  'sourceSize: 5',
  'provider: openai',
  'model: gpt-5.5',
  'generatedAt: "2026-06-16T00:00:00.000Z"',
  '---',
  '',
  '# Asset description',
  '',
  'A whiteboard with the launch checklist.',
].join('\n')

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

function installBridge(options: {
  refs?: Array<{ notePath: string; isPrivate: number }>
  sidecar?: string
  referencedAssets?: string[]
  indexedAssets?: string[]
}): void {
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'note_read') {
      if (options.sidecar === undefined) {
        throw { kind: 'notFound', message: 'missing' }
      }
      return options.sidecar
    }
    if (command === 'db_query') {
      const sql = String(args['sql'])
      if (sql.includes('inner join "notes"')) {
        return options.refs ?? []
      }
      if (sql.includes('from "assets"')) {
        return (options.referencedAssets ?? []).map((assetPath) => ({ assetPath }))
      }
      if (sql.includes('from "asset_search"')) {
        return (options.indexedAssets ?? []).map((assetPath) => ({ assetPath }))
      }
      return []
    }
    return null
  })
}

describe('reconcileAssetSearch', () => {
  it('indexes managed sidecar text for public referencing notes', async () => {
    installBridge({
      refs: [{ notePath: 'notes/launch.md', isPrivate: 0 }],
      sidecar: managedSidecar,
    })

    await reconcileAssetSearch('assets/photo.png', 7)

    const apply = mockInvoke.mock.calls.find(([command]) => command === 'index_asset_search_apply')
    expect(apply?.[1]).toMatchObject({
      assetPath: 'assets/photo.png',
      generation: 7,
    })
    const rows = apply?.[1]['rows'] as Array<{ notePath: string; text: string; sourceHash: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      notePath: 'notes/launch.md',
      sourceHash: 'source-hash',
    })
    expect(rows[0]?.text).toContain('launch checklist')
    expect(rows[0]?.text).not.toContain('reflectAssetDescription')
  })

  it('removes rows for private, mixed, unreferenced, or unmanaged assets', async () => {
    installBridge({
      refs: [
        { notePath: 'notes/public.md', isPrivate: 0 },
        { notePath: 'notes/private.md', isPrivate: 1 },
      ],
      sidecar: managedSidecar,
    })
    await reconcileAssetSearch('assets/photo.png', 7)

    installBridge({ refs: [], sidecar: managedSidecar })
    await reconcileAssetSearch('assets/photo.png', 7)

    installBridge({
      refs: [{ notePath: 'notes/public.md', isPrivate: 0 }],
      sidecar: '# user-authored markdown',
    })
    await reconcileAssetSearch('assets/photo.png', 7)

    const removes = mockInvoke.mock.calls.filter(
      ([command]) => command === 'index_asset_search_remove',
    )
    expect(removes).toHaveLength(3)
    expect(mockInvoke.mock.calls.some(([command]) => command === 'index_asset_search_apply')).toBe(
      false,
    )
  })
})

describe('rebuildAssetSearchIndex', () => {
  it('reconciles referenced and previously indexed assets', async () => {
    installBridge({
      referencedAssets: ['assets/a.png'],
      indexedAssets: ['assets/stale.pdf'],
      refs: [],
      sidecar: managedSidecar,
    })

    await rebuildAssetSearchIndex({ generation: 4 })

    const removed = mockInvoke.mock.calls
      .filter(([command]) => command === 'index_asset_search_remove')
      .map(([, args]) => args['assetPath'])
    expect(removed).toEqual(['assets/a.png', 'assets/stale.pdf'])
  })
})
