import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeOwnWrites } from '../indexing/local-write-echo'
import { setBridge } from '../ipc/bridge'
import { importReflectV1Zip, markReflectV1ImportOwnWrites, openAsset } from './commands'

afterEach(() => {
  setBridge(null)
})

describe('graph commands', () => {
  it('opens assets through the generation-pinned native command', async () => {
    const invoke = vi.fn(async () => null)
    setBridge({ invoke, listen: async () => () => {} })

    await openAsset('assets/cat.png', 7)

    expect(invoke).toHaveBeenCalledWith('asset_open', {
      path: 'assets/cat.png',
      generation: 7,
    })
  })

  it('imports Reflect V1 zips through the generation-pinned native command', async () => {
    const invoke = vi.fn(async () => ({
      importedFiles: 2,
      skippedFiles: 0,
      downloadedAssets: 0,
      failedAssetDownloads: 0,
      renamedFiles: 0,
      changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
    }))
    setBridge({ invoke, listen: async () => () => {} })
    const summary = await importReflectV1Zip('/tmp/reflect-v1.zip', 7)

    expect(invoke).toHaveBeenCalledWith('graph_import_reflect_v1_zip', {
      path: '/tmp/reflect-v1.zip',
      generation: 7,
    })
    expect(summary).toEqual({
      importedFiles: 2,
      skippedFiles: 0,
      downloadedAssets: 0,
      failedAssetDownloads: 0,
      renamedFiles: 0,
      changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
    })
  })

  it('marks completed import files as this device’s own writes', () => {
    const seen: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      seen.push(path)
    })
    try {
      markReflectV1ImportOwnWrites({
        importedFiles: 2,
        skippedFiles: 0,
        downloadedAssets: 0,
        failedAssetDownloads: 0,
        renamedFiles: 0,
        changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
      })

      expect(seen).toEqual(['notes/a.md', 'daily/2026-07-04.md'])
    } finally {
      unlisten()
    }
  })
})
