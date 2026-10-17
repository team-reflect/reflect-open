import type { MaybePromise } from '@reflect/utils'
import { describe, expect, it, vi } from 'vitest'
import { ReflectError } from '../errors.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { FileMeta } from '../graph/schemas.ts'
import {
  createTestAssetStoreService,
  createTestClockService,
  createTestFileChangeService,
  createTestGraphSessionService,
  createTestNoteFileService,
  createTestProgressPort,
  createTestPlatformService,
} from '../testing/index.ts'
import {
  LARGE_FILE_BYTES,
  createAttachmentService,
  type AttachmentInsertTarget,
} from './attachment-service.ts'

interface Listing {
  path: string
  size: number
}

/**
 * A note file service listing `listing()` once `gate` settles, counting calls.
 */
function listingNoteFile(
  listing: () => MaybePromise<readonly Listing[]>,
): NoteFileService & { listings: () => number } {
  let calls = 0
  return Object.assign(createTestNoteFileService(), {
    async listAttachments(): Promise<FileMeta[]> {
      calls += 1
      const entries = await listing()
      return entries.map((entry) => ({ ...entry, modifiedMs: 0 }))
    },
    listings: () => calls,
  })
}

function setup(options?: { assetStore?: AssetStoreService; noteFile?: NoteFileService }) {
  const clock = createTestClockService({ now: 1_700_000_000_000 })
  const assetStore = options?.assetStore ?? createTestAssetStoreService()
  const noteFile = options?.noteFile ?? createTestNoteFileService()
  const fileChanges = createTestFileChangeService()
  const progress = createTestProgressPort()
  const graph = createTestGraphSessionService({ graph: { generation: 3 } })
  const attachments = createAttachmentService({
    assetStore,
    noteFile,
    fileChanges,
    progress,
    clock,
    platform: createTestPlatformService(),
    graphSession: graph,
  })
  return { attachments, assetStore, noteFile, fileChanges, progress, clock, graph }
}

function fileOf(name: string, type: string, size = 16): File {
  const file = new File([new Uint8Array(Math.min(size, 64))], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function assetUrl(generation: number, path: string): string {
  return `reflect-asset://localhost/${encodeURIComponent(`${generation}/${path}`)}`
}

function failing(message: string): () => Promise<never> {
  return async () => {
    throw new ReflectError('io', message)
  }
}

describe('saveFile', () => {
  it('names a pasted image pasted-<now>.<ext>, leaving collisions to the store', async () => {
    const { attachments } = setup()

    await expect(attachments.saveFile(fileOf('whatever.png', 'image/png'))).resolves.toEqual({
      ok: true,
      path: 'assets/pasted-1700000000000.png',
    })
    await expect(attachments.saveFile(fileOf('again.png', 'image/png'))).resolves.toEqual({
      ok: true,
      path: 'assets/pasted-1700000000000-2.png',
    })
  })

  it('keeps an attachment under its sanitized original name', async () => {
    const assetStore = createTestAssetStoreService()
    const { attachments } = setup({ assetStore })

    await expect(attachments.saveFile(fileOf('Q3 Report.PDF', 'application/pdf'))).resolves.toEqual(
      { ok: true, path: 'assets/q3-report.pdf' },
    )
    expect(assetStore.uploads()).toEqual([
      { kind: 'blob', path: 'assets/q3-report.pdf', generation: 3 },
    ])
  })

  it('treats an image MIME without a known extension as a named attachment', async () => {
    const { attachments } = setup()

    await expect(attachments.saveFile(fileOf('Scan 1.tiff', 'image/tiff'))).resolves.toEqual({
      ok: true,
      path: 'assets/scan-1.tiff',
    })
  })

  it('saves a large file without asking, with a status-line warning after', async () => {
    const { attachments, progress } = setup()

    await attachments.saveFile(fileOf('huge.mov', 'video/quicktime', LARGE_FILE_BYTES + 1))

    const warning = progress.findByLabel('Large file added')
    expect(warning?.status).toBe('warning')
    expect(warning?.message).toMatch(/“huge\.mov” is 25 MB/)
    expect(warning?.message).toMatch(/100 MB/)

    await attachments.saveFile(fileOf('small.pdf', 'application/pdf'))
    expect(progress.getAll().filter((operation) => operation.status === 'warning')).toHaveLength(1)
  })

  it('reports failures keyed by how the file was named, never rejecting', async () => {
    const { attachments } = setup({
      assetStore: Object.assign(createTestAssetStoreService(), {
        uploadBlob: failing('disk full'),
      }),
    })

    await expect(attachments.saveFile(fileOf('a.png', 'image/png'))).resolves.toEqual({
      ok: false,
      error: { kind: 'image', message: 'disk full' },
    })
    await expect(attachments.saveFile(fileOf('scan.tiff', 'image/tiff'))).resolves.toEqual({
      ok: false,
      error: { kind: 'file', message: 'disk full' },
    })
  })
})

describe('createSaveScope', () => {
  it('holds the latest failure until the next success', async () => {
    const assetStore = createTestAssetStoreService()
    let failure: string | null = 'disk full'
    const uploadBlob = assetStore.uploadBlob.bind(assetStore)
    vi.spyOn(assetStore, 'uploadBlob').mockImplementation(async (name, contents, generation) => {
      if (failure !== null) {
        throw new ReflectError('io', failure)
      }
      return await uploadBlob(name, contents, generation)
    })
    const { attachments } = setup({
      assetStore,
    })
    const scope = attachments.createSaveScope()
    let notified = 0
    scope.subscribe(() => {
      notified += 1
    })

    await expect(scope.saveFile(fileOf('a.png', 'image/png'))).resolves.toBeNull()
    expect(scope.error()).toEqual({ kind: 'image', message: 'disk full' })

    failure = null
    await expect(scope.saveFile(fileOf('b.pdf', 'application/pdf'))).resolves.toBe('assets/b.pdf')
    expect(scope.error()).toBeNull()
    expect(notified).toBe(2)
  })

  it('drops an outcome that lands after a reset', async () => {
    const upload = Promise.withResolvers<string>()
    const { attachments } = setup({
      assetStore: Object.assign(createTestAssetStoreService(), {
        uploadBlob: () => upload.promise,
      }),
    })
    const scope = attachments.createSaveScope()

    const saving = scope.saveFile(fileOf('slow.pdf', 'application/pdf'))
    scope.reset()
    upload.reject(new ReflectError('io', 'late failure'))

    await expect(saving).resolves.toBeNull()
    expect(scope.error()).toBeNull()
  })

  it('keeps each scope separate', async () => {
    const { attachments } = setup({
      assetStore: Object.assign(createTestAssetStoreService(), {
        uploadBlob: failing('disk full'),
      }),
    })
    const first = attachments.createSaveScope()
    const second = attachments.createSaveScope()

    await first.saveFile(fileOf('a.pdf', 'application/pdf'))
    second.reset()

    expect(first.error()).toEqual({ kind: 'file', message: 'disk full' })
    expect(second.error()).toBeNull()
  })
})

describe('resolveImageUrl', () => {
  it('passes remote URLs through untouched', () => {
    const { attachments, graph } = setup()

    expect(attachments.resolveImageUrl('notes/a.md', 'https://example.com/cat.png')).toBe(
      'https://example.com/cat.png',
    )
    graph.setGraph(null)
    expect(attachments.resolveImageUrl('notes/a.md', 'HTTP://example.com/cat.png')).toBe(
      'HTTP://example.com/cat.png',
    )
  })

  it('maps an assets/ path onto the generation-pinned reflect-asset URL', async () => {
    const { attachments } = setup()

    await expect(attachments.resolveImageUrl('notes/a.md', 'assets/cat.png')).resolves.toBe(
      assetUrl(3, 'assets/cat.png'),
    )
    // Once the catalog is loaded, the answer is synchronous.
    expect(attachments.resolveImageUrl('notes/a.md', 'assets/cat.png')).toBe(
      assetUrl(3, 'assets/cat.png'),
    )
  })

  it("resolves a vault image from the note's own folder, preferring the file beside it", async () => {
    const noteFile = listingNoteFile(() => [
      { path: 'Projects/attachments/plan.png', size: 1 },
      { path: 'attachments/plan.png', size: 1 },
      { path: 'attachments/garden-budget.png', size: 1 },
    ])
    const { attachments } = setup({ noteFile })
    await attachments.loadCatalog()

    expect(
      attachments.resolveImageUrl(
        'Projects/Garden redesign.md',
        '../attachments/garden-budget.png',
      ),
    ).toBe(assetUrl(3, 'attachments/garden-budget.png'))
    expect(attachments.resolveImageUrl('Projects/Plan.md', 'attachments/plan.png')).toBe(
      assetUrl(3, 'Projects/attachments/plan.png'),
    )
    expect(
      attachments.resolveAssetOpenPath(
        'Projects/Garden redesign.md',
        '../attachments/garden-budget.png',
      ),
    ).toBe('attachments/garden-budget.png')
  })

  it('waits for the first listing', async () => {
    const listing = Promise.withResolvers<readonly Listing[]>()
    const { attachments } = setup({ noteFile: listingNoteFile(() => listing.promise) })

    const url = attachments.resolveImageUrl('Home.md', 'garden-budget.png')
    expect(url).toBeInstanceOf(Promise)
    listing.resolve([{ path: 'attachments/garden-budget.png', size: 1 }])
    await expect(url).resolves.toBe(assetUrl(3, 'attachments/garden-budget.png'))
  })

  it('falls back to the vault-root reading when the listing fails', async () => {
    const { attachments } = setup({
      noteFile: Object.assign(createTestNoteFileService(), {
        listAttachments: failing('bridge down'),
      }),
    })

    await expect(attachments.resolveImageUrl('notes/a.md', 'assets/cat.png')).resolves.toBe(
      assetUrl(3, 'assets/cat.png'),
    )
  })

  it('declines unsafe paths, notes, and missing sessions', async () => {
    const { attachments, graph } = setup()

    expect(await attachments.resolveImageUrl('notes/a.md', 'assets/../secrets.env')).toBe(undefined)
    expect(await attachments.resolveImageUrl('notes/a.md', '../../outside.png')).toBe(undefined)
    expect(await attachments.resolveImageUrl('notes/a.md', 'notes/other.md')).toBe(undefined)
    graph.setGraph(null)
    expect(attachments.resolveImageUrl('notes/a.md', 'assets/cat.png')).toBeUndefined()
  })
})

describe('resolvePreviewImageUrl', () => {
  it('serves only local raster images, with the raster-only query', async () => {
    const { attachments } = setup()

    await expect(
      attachments.resolvePreviewImageUrl('notes/alpha.md', 'https://example.com/cat.png', 7),
    ).resolves.toBeUndefined()
    await expect(
      attachments.resolvePreviewImageUrl('notes/alpha.md', '../../outside.png', 7),
    ).resolves.toBeUndefined()
    await expect(
      attachments.resolvePreviewImageUrl('notes/alpha.md', 'assets/vector.svg', 7),
    ).resolves.toBeUndefined()
    await expect(
      attachments.resolvePreviewImageUrl('notes/alpha.md', 'assets/cat.png', 7),
    ).resolves.toBe(`${assetUrl(7, 'assets/cat.png')}?reflect-preview=raster`)
  })
})

describe('resolveWikiEmbed', () => {
  it('hands out embed sources that read back as the same file', async () => {
    const noteFile = listingNoteFile(() => [
      { path: 'Media/my photo #1.png', size: 1 },
      { path: 'Media/100%.pdf', size: 1 },
    ])
    const { attachments } = setup({ noteFile })
    await attachments.loadCatalog()

    const image = attachments.resolveWikiEmbed('Media/my photo #1.png')
    const file = attachments.resolveWikiEmbed('100%.pdf')
    expect(image).toEqual({ kind: 'image', src: '/Media/my%20photo%20%231.png' })
    expect(attachments.resolveAttachmentPath('Home.md', '/Media/my%20photo%20%231.png')).toBe(
      'Media/my photo #1.png',
    )
    expect(file?.kind === 'file' && attachments.resolveAttachmentPath('Home.md', file.href)).toBe(
      'Media/100%.pdf',
    )
    expect(attachments.resolveWikiEmbed('Deep Work')).toEqual({ kind: 'note' })
    expect(attachments.resolveWikiEmbed('../outside.png')).toBeUndefined()
  })
})

describe('claimsFileLink', () => {
  it('claims links to local attachments, resolved from the note folder', () => {
    const { attachments } = setup()
    const claims = (href: string): boolean => attachments.claimsFileLink('Projects/Plan.md', href)

    expect(claims('assets/q3-report.pdf')).toBe(true)
    expect(claims('assets/sub/archive.zip')).toBe(true)
    expect(claims('assets/tool.xyz')).toBe(true)
    expect(claims('assets/readme')).toBe(true)
    expect(claims('assets/../tool.xyz')).toBe(false)
    expect(claims('assets/.hidden/tool.xyz')).toBe(false)
    expect(claims('assets/tool\0.xyz')).toBe(false)
    expect(claims('other/tool.xyz')).toBe(false)
    expect(claims('../attachments/report.pdf')).toBe(true)

    expect(claims('https://example.com/q3.pdf')).toBe(false)
    expect(claims('notes/other.md')).toBe(false)
    expect(claims('assets/../secrets.env')).toBe(false)
    expect(claims(String.raw`assets\evil.pdf`)).toBe(false)
    expect(claims('assets/')).toBe(false)
    expect(claims('../../outside.pdf')).toBe(false)
  })
})

describe('resolveFileInfo', () => {
  it('lists the vault attachments once for a burst of pills', async () => {
    const noteFile = listingNoteFile(() => [
      { path: 'assets/q3-report.pdf', size: 1234 },
      { path: 'assets/archive.zip', size: 5678 },
    ])
    const { attachments } = setup({ noteFile })

    const [report, archive] = await Promise.all([
      attachments.resolveFileInfo('notes/a.md', 'assets/q3-report.pdf'),
      attachments.resolveFileInfo('notes/a.md', 'assets/archive.zip'),
    ])

    expect(report).toEqual({ size: 1234 })
    expect(archive).toEqual({ size: 5678 })
    expect(noteFile.listings()).toBe(1)
  })

  it('sizes vault attachments outside assets/, including embed sources', async () => {
    const noteFile = listingNoteFile(() => [{ path: 'attachments/report.pdf', size: 42 }])
    const { attachments } = setup({ noteFile })

    await expect(
      attachments.resolveFileInfo('Projects/Plan.md', '../attachments/report.pdf'),
    ).resolves.toEqual({ size: 42 })
    await expect(
      attachments.resolveFileInfo('Projects/Plan.md', '/attachments/report.pdf'),
    ).resolves.toEqual({ size: 42 })
  })

  it('serves a just-saved file from the save itself', async () => {
    const noteFile = listingNoteFile(() => [])
    const { attachments, graph } = setup({ noteFile })

    await attachments.saveFile(fileOf('Q3 Report.PDF', 'application/pdf', 1234))

    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/q3-report.pdf'),
    ).resolves.toEqual({ size: 1234 })
    expect(noteFile.listings()).toBe(0)
    // Another graph session never sees it.
    graph.setGraph({ generation: 4 })
    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/q3-report.pdf'),
    ).resolves.toBeUndefined()
  })

  it('declines remote or unsafe hrefs, missing files, and missing sessions', async () => {
    const noteFile = listingNoteFile(() => [
      { path: 'secrets.env', size: 9 },
      { path: 'assets/other.pdf', size: 9 },
    ])
    const { attachments, graph } = setup({ noteFile })

    await expect(
      attachments.resolveFileInfo('notes/a.md', 'https://example.com/q3.pdf'),
    ).resolves.toBeUndefined()
    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/../secrets.env'),
    ).resolves.toBeUndefined()
    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/gone.pdf'),
    ).resolves.toBeUndefined()
    const listings = noteFile.listings()
    graph.setGraph(null)
    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/other.pdf'),
    ).resolves.toBeUndefined()
    expect(noteFile.listings()).toBe(listings)
  })

  it('degrades to no size when the listing fails', async () => {
    const { attachments } = setup({
      noteFile: Object.assign(createTestNoteFileService(), {
        listAttachments: failing('bridge down'),
      }),
    })

    await expect(
      attachments.resolveFileInfo('notes/a.md', 'assets/q3.pdf'),
    ).resolves.toBeUndefined()
  })

  it('never serves a listing that lands after the graph session switched', async () => {
    const listings: PromiseWithResolvers<readonly Listing[]>[] = []
    const { attachments, graph } = setup({
      noteFile: listingNoteFile(() => {
        const listing = Promise.withResolvers<readonly Listing[]>()
        listings.push(listing)
        return listing.promise
      }),
    })

    const staleLookup = attachments.resolveFileInfo('notes/a.md', 'assets/q3.pdf')
    await Promise.resolve()
    graph.setGraph({ generation: 4 })
    const freshLookup = attachments.resolveFileInfo('notes/a.md', 'assets/q3.pdf')
    listings[0]?.resolve([{ path: 'assets/q3.pdf', size: 999 }])
    await staleLookup
    expect(attachments.peekCatalog()).toBeNull()

    listings[1]?.resolve([{ path: 'assets/q3.pdf', size: 111 }])
    await expect(freshLookup).resolves.toEqual({ size: 111 })
  })
})

describe('watchCatalog', () => {
  it('re-lists when an attachment changes, not when only a note does', async () => {
    let files: readonly Listing[] = []
    const noteFile = listingNoteFile(() => files)
    const { attachments, fileChanges } = setup({ noteFile })
    let changes = 0
    attachments.onCatalogChanged(() => {
      changes += 1
    })

    const stop = attachments.watchCatalog(3)
    await attachments.loadCatalog()
    expect(noteFile.listings()).toBe(1)
    expect(changes).toBe(1)

    fileChanges.emit({
      changes: [{ path: 'Home.md', kind: 'upsert', modifiedMs: 1 }],
      source: 'external',
    })
    await Promise.resolve()
    expect(noteFile.listings()).toBe(1)

    files = [{ path: 'attachments/garden-budget.png', size: 1 }]
    fileChanges.emit({
      changes: [{ path: 'attachments/garden-budget.png', kind: 'upsert', modifiedMs: 1 }],
      source: 'external',
    })
    await expect.poll(() => changes).toBe(2)
    expect(noteFile.listings()).toBe(2)
    expect(attachments.resolveImageUrl('Home.md', 'garden-budget.png')).toBe(
      assetUrl(3, 'attachments/garden-budget.png'),
    )

    stop()
    expect(fileChanges.listenerCount()).toEqual({ changes: 0, reconcile: 0 })
  })

  it('re-lists on a folder-level reconcile request', async () => {
    const noteFile = listingNoteFile(() => [])
    const { attachments, fileChanges } = setup({ noteFile })

    attachments.watchCatalog(3)
    await attachments.loadCatalog()
    fileChanges.emitReconcile()

    await expect.poll(() => noteFile.listings()).toBe(2)
  })

  it('keeps the catalog and stays quiet when a re-listing is unchanged', async () => {
    const noteFile = listingNoteFile(() => [{ path: 'assets/a.png', size: 1 }])
    const { attachments, fileChanges } = setup({ noteFile })
    let changes = 0
    attachments.onCatalogChanged(() => {
      changes += 1
    })

    attachments.watchCatalog(3)
    const first = await attachments.loadCatalog()
    fileChanges.emitReconcile()
    await expect.poll(() => noteFile.listings()).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(attachments.peekCatalog()).toBe(first)
    expect(changes).toBe(1)
  })
})

function editor(): AttachmentInsertTarget & { inserted: string[]; focused: number } {
  const target = {
    inserted: [] as string[],
    focused: 0,
    insertMarkdown(markdown: string) {
      target.inserted.push(markdown)
    },
    focus() {
      target.focused += 1
    },
  }
  return target
}

describe('attachFilesToNote', () => {
  it('imports each pick and inserts one link per line', async () => {
    const assetStore = createTestAssetStoreService({
      sources: { '/Users/me/Q3 Report.pdf': 'a', '/Users/me/archive.tar.gz': 'b' },
    })
    const { attachments } = setup({ assetStore })
    const target = editor()

    await attachments.attachFilesToNote({
      sources: ['/Users/me/Q3 Report.pdf', '/Users/me/archive.tar.gz'],
      findEditor: () => target,
    })

    expect(assetStore.uploads()).toEqual([
      { kind: 'import', path: 'assets/q3-report.pdf', generation: 3 },
      { kind: 'import', path: 'assets/archive-tar.gz', generation: 3 },
    ])
    expect(target.inserted).toEqual([
      '[Q3 Report.pdf](assets/q3-report.pdf)\n[archive.tar.gz](assets/archive-tar.gz)',
    ])
    expect(target.focused).toBe(1)
  })

  it('escapes bracketed filenames in the link label', async () => {
    const { attachments } = setup({
      assetStore: createTestAssetStoreService({ sources: { '/tmp/report [v2].pdf': 'a' } }),
    })
    const target = editor()

    await attachments.attachFilesToNote({
      sources: ['/tmp/report [v2].pdf'],
      findEditor: () => target,
    })

    expect(target.inserted).toEqual([String.raw`[report \[v2\].pdf](assets/report-v2.pdf)`])
  })

  it('does nothing without a mounted editor or a source', async () => {
    const assetStore = createTestAssetStoreService({ sources: { '/tmp/report.pdf': 'a' } })
    const { attachments } = setup({ assetStore })

    await attachments.attachFilesToNote({ sources: ['/tmp/report.pdf'], findEditor: () => null })

    const target = editor()
    await attachments.attachFilesToNote({ sources: [], findEditor: () => target })
    expect(assetStore.uploads()).toEqual([])
    expect(target.inserted).toEqual([])
  })

  it('looks the editor up again after the copies and reports a closed note', async () => {
    const assetStore = createTestAssetStoreService({ sources: { '/tmp/report.pdf': 'a' } })
    const { attachments, progress } = setup({ assetStore })
    const target = editor()
    let mounted = true

    const attaching = attachments.attachFilesToNote({
      sources: ['/tmp/report.pdf'],
      findEditor: () => (mounted ? target : null),
    })
    mounted = false
    await attaching

    expect(assetStore.uploads()).toHaveLength(1)
    expect(target.inserted).toEqual([])
    const failure = progress.findByLabel('Attaching file')
    expect(failure?.status).toBe('failed')
    expect(failure?.message).toMatch(/report\.pdf were still copied into assets\//)
  })

  it('continues past a failed copy, links every file that landed, and reports the failure', async () => {
    const assetStore = createTestAssetStoreService({
      sources: { '/tmp/good.pdf': 'a', '/tmp/also good.pdf': 'b' },
    })
    const { attachments, progress } = setup({ assetStore })
    const target = editor()

    await attachments.attachFilesToNote({
      sources: ['/tmp/bad.bin', '/tmp/good.pdf', '/tmp/also good.pdf'],
      findEditor: () => target,
    })

    expect(target.inserted).toEqual([
      '[good.pdf](assets/good.pdf)\n[also good.pdf](assets/also-good.pdf)',
    ])
    const failure = progress.findByLabel('Attaching file')
    expect(failure?.status).toBe('failed')
    expect(failure?.message).toBe('could not be copied: bad.bin (/tmp/bad.bin not found)')
  })
})

describe('openOrReveal', () => {
  it('opens without touching the reveal fallback', async () => {
    const assetStore = createTestAssetStoreService()
    const { attachments, progress } = setup({ assetStore })

    await attachments.openOrReveal('assets/q3-report.pdf')

    expect(assetStore.opened()).toEqual(['assets/q3-report.pdf'])
    expect(assetStore.revealed()).toEqual([])
    expect(progress.getAll()).toEqual([])
  })

  it('degrades a refused file type to a reveal, with a status-line note', async () => {
    const assetStore = createTestAssetStoreService()
    const { attachments, progress } = setup({
      assetStore: Object.assign(assetStore, { open: failing('not a supported attachment path') }),
    })

    await attachments.openOrReveal('assets/tool.xyz')

    expect(assetStore.revealed()).toEqual(['assets/tool.xyz'])
    const warning = progress.findByLabel('Opening attachment')
    expect(warning?.status).toBe('warning')
    expect(warning?.message).toMatch(/revealed in Finder/)
  })

  it('surfaces the open error when the reveal fails too', async () => {
    const { attachments, progress } = setup({
      assetStore: Object.assign(createTestAssetStoreService(), {
        open: failing('not a supported attachment path: assets/tool.xyz'),
        reveal: failing('asset not found: assets/tool.xyz'),
      }),
    })

    await attachments.openOrReveal('assets/tool.xyz')

    const failure = progress.findByLabel('Opening attachment')
    expect(failure?.status).toBe('failed')
    expect(failure?.message).toBe('not a supported attachment path: assets/tool.xyz')
  })
})

describe('with no graph open', () => {
  it('saves, attaches, and opens nothing, and rejects a catalog load', async () => {
    const assetStore = createTestAssetStoreService({ sources: { '/tmp/report.pdf': 'a' } })
    const { attachments, graph } = setup({ assetStore })
    const scope = attachments.createSaveScope()
    graph.setGraph(null)

    await expect(attachments.saveFile(fileOf('a.pdf', 'application/pdf'))).resolves.toBeNull()
    await expect(scope.saveFile(fileOf('a.pdf', 'application/pdf'))).resolves.toBeNull()
    await attachments.attachFilesToNote({
      sources: ['/tmp/report.pdf'],
      findEditor: () => editor(),
    })
    await attachments.openOrReveal('assets/a.pdf')

    expect(scope.error()).toBeNull()
    expect(assetStore.uploads()).toEqual([])
    expect(attachments.peekCatalog()).toBeNull()
    await expect(attachments.loadCatalog()).rejects.toThrow('No graph is open.')
  })
})
