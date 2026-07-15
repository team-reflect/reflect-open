import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { emitFileChanges, setBridge, type FileMeta } from '@reflect/core'

// jsdom has no Tauri runtime; mirror the macOS/iOS URL shape the injected
// `convertFileSrc` produces (one percent-encoded path segment).
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (filePath: string, protocol = 'asset') =>
    `${protocol}://localhost/${encodeURIComponent(filePath)}`,
}))
import { resetOperations, useOperations, type Operation } from '@/lib/operations'
import {
  LARGE_FILE_BYTES,
  relativeAttachmentHref,
  resolveAssetFileLink,
  useAssetPersistence,
  vaultAttachmentReference,
  type AssetPersistence,
} from './use-asset-persistence'
import { AttachmentCatalogProvider } from '@/providers/attachment-catalog-provider'

let persistence: AssetPersistence | null = null
let operations: Operation[] = []

function OperationsProbe(): ReactNode {
  operations = useOperations()
  return null
}

function Host({
  generation,
  path = 'notes/a.md',
}: {
  generation: number | null
  path?: string
}): ReactNode {
  persistence = useAssetPersistence(generation, path)
  return null
}

/** A bridge whose upload commands succeed, echoing the committed name back. */
function installUploadBridge(): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (command: string, args: Record<string, unknown>) =>
    command === 'asset_upload_begin'
      ? 'upload-1'
      : command === 'asset_upload_commit'
        ? `assets/${args['desiredName'] as string}`
        : null,
  )
  setBridge({ invoke, invokeBinary: async () => null, listen: async () => () => {} })
  return invoke
}

function fileOf(name: string, type: string, size = 16): File {
  const file = new File([new Uint8Array(Math.min(size, 64))], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setBridge(null)
  persistence = null
  resetOperations()
  operations = []
})

describe('useAssetPersistence saveFile', () => {
  it('names a pasted image pasted-<timestamp>.<ext>, leaving collisions to Rust', async () => {
    installUploadBridge()
    render(<Host generation={3} />)

    let saved: string | null = null
    await act(async () => {
      saved = await persistence!.saveFile(fileOf('whatever.png', 'image/png'))
    })

    expect(saved).toMatch(/^\.\.\/assets\/pasted-\d+\.png$/)
  })

  it('keeps an attachment under its sanitized original name', async () => {
    installUploadBridge()
    render(<Host generation={3} />)

    let saved: string | null = null
    await act(async () => {
      saved = await persistence!.saveFile(fileOf('Q3 Report.PDF', 'application/pdf'))
    })

    expect(saved).toBe('../assets/q3-report.pdf')
  })

  it('rejects unsupported image and file formats before uploading', async () => {
    const invoke = installUploadBridge()
    render(<Host generation={3} />)

    await act(async () => {
      await expect(
        persistence!.saveFile(fileOf('Scan 1.tiff', 'image/tiff')),
      ).resolves.toBeNull()
    })
    expect(persistence!.saveError).toMatchObject({ kind: 'image' })
    await act(async () => {
      await expect(
        persistence!.saveFile(fileOf('Archive.zip', 'application/zip')),
      ).resolves.toBeNull()
    })
    expect(persistence!.saveError).toMatchObject({ kind: 'file' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('saves a large file without asking, with a status-line warning after', async () => {
    installUploadBridge()
    render(
      <>
        <Host generation={3} />
        <OperationsProbe />
      </>,
    )

    let saved: string | null = null
    await act(async () => {
      saved = await persistence!.saveFile(
        fileOf('huge.mov', 'video/quicktime', LARGE_FILE_BYTES + 1),
      )
    })

    expect(saved).toBe('../assets/huge.mov')
    const warning = operations.find((operation) => operation.status === 'warning')
    expect(warning?.message).toMatch(/“huge\.mov” is 25 MB/)
    expect(warning?.message).toMatch(/100 MB/)

    // A small file warns about nothing.
    await act(async () => {
      await persistence!.saveFile(fileOf('small.pdf', 'application/pdf'))
    })
    expect(operations.filter((operation) => operation.status === 'warning')).toHaveLength(1)
  })

  it('declines without a graph session', async () => {
    const invoke = installUploadBridge()
    render(<Host generation={null} />)

    let saved: string | null = 'sentinel'
    await act(async () => {
      saved = await persistence!.saveFile(fileOf('a.pdf', 'application/pdf'))
    })
    expect(saved).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('relativeAttachmentHref', () => {
  it('keeps root notes direct and makes nested note pastes source-relative', () => {
    expect(relativeAttachmentHref('README.md', 'assets/photo.png')).toBe('assets/photo.png')
    expect(relativeAttachmentHref('Projects/Plan.md', 'assets/photo.png')).toBe(
      '../assets/photo.png',
    )
    expect(relativeAttachmentHref('Projects/2026/Plan.md', 'assets/photo.png')).toBe(
      '../../assets/photo.png',
    )
  })
})

describe('useAssetPersistence resolveImageUrl', () => {
  it('passes remote URLs through untouched', () => {
    installUploadBridge()
    render(<Host generation={3} />)

    expect(persistence!.resolveImageUrl('https://example.com/cat.png')).toBe(
      'https://example.com/cat.png',
    )
  })

  it('maps a safe assets/ path onto the generation-pinned reflect-asset URL', () => {
    installUploadBridge()
    render(<Host generation={3} />)

    expect(persistence!.resolveImageUrl('assets/cat.png')).toBe(
      `reflect-asset://localhost/${encodeURIComponent('3/assets/cat.png')}?reflect-catalog=0`,
    )
  })

  it('declines unsafe paths and missing sessions', () => {
    installUploadBridge()
    render(<Host generation={3} />)

    expect(persistence!.resolveImageUrl('assets/../secrets.env')).toBeNull()
    expect(persistence!.resolveImageUrl('notes/other.md')).toBeNull()

    render(<Host generation={null} />)
    expect(persistence!.resolveImageUrl('assets/cat.png')).toBeNull()
  })
})

function fileLink(href: string): { href: string; label: string; title: string } {
  return { href, label: 'label', title: '' }
}

describe('resolveAssetFileLink', () => {
  it('claims safe graph-relative assets/ links only', () => {
    expect(resolveAssetFileLink(fileLink('assets/q3-report.pdf'))).toBe(true)
    expect(resolveAssetFileLink(fileLink('assets/sub/manual.pdf'))).toBe(true)
    expect(resolveAssetFileLink(fileLink('assets/sub/archive.zip'))).toBe(false)

    expect(resolveAssetFileLink(fileLink('https://example.com/q3.pdf'))).toBe(false)
    expect(resolveAssetFileLink(fileLink('notes/other.md'))).toBe(false)
    expect(resolveAssetFileLink(fileLink('assets/../secrets.env'))).toBe(false)
    expect(resolveAssetFileLink(fileLink('assets\\evil.pdf'))).toBe(false)
    expect(resolveAssetFileLink(fileLink('assets/'))).toBe(false)
  })
})

describe('useAssetPersistence catalog resolution', () => {
  it('hands a just-saved path back to the catalog after its first manifest refresh', async () => {
    let files: readonly FileMeta[] = []
    const invoke = vi.fn(async (command: string, args: Record<string, unknown>) => {
      if (command === 'list_attachments') {
        return files
      }
      if (command === 'asset_upload_begin') {
        return 'upload-1'
      }
      if (command === 'asset_upload_commit') {
        const path = `assets/${args['desiredName'] as string}`
        files = [{ path, size: 16, modifiedMs: 1 }]
        return path
      }
      return null
    })
    setBridge({ invoke, invokeBinary: async () => null, listen: async () => () => {} })
    render(
      <AttachmentCatalogProvider generation={7}>
        <Host generation={7} />
      </AttachmentCatalogProvider>,
    )

    let href: string | null = null
    await act(async () => {
      href = await persistence!.saveFile(fileOf('Q3 Report.pdf', 'application/pdf'))
    })
    expect(href).toBe('../assets/q3-report.pdf')
    const savedHref = href
    if (savedHref === null) {
      throw new Error('expected the attachment save to return an href')
    }
    act(() => emitFileChanges([{ path: 'assets/q3-report.pdf', kind: 'upsert' }]))
    await waitFor(() => expect(persistence!.attachmentCatalogRevision).toBe(1))
    expect(persistence!.resolveFileLink(fileLink(savedHref))).toBe(true)

    files = []
    act(() => emitFileChanges([{ path: 'assets/q3-report.pdf', kind: 'remove' }]))
    await waitFor(() => expect(persistence!.attachmentCatalogRevision).toBe(2))
    expect(persistence!.resolveFileLink(fileLink(savedHref))).toBe(false)
  })

  it('resolves nested Markdown paths and unique wiki embeds through the graph catalog', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'list_attachments') {
        return [
            {
              path: 'Projects/images/photo one.png',
              size: 40,
              modifiedMs: 1,
            },
            { path: 'Media/manual.pdf', size: 80, modifiedMs: 2 },
            { path: 'Media/diagram.png', size: 60, modifiedMs: 3 },
          ]
      }
      if (command === 'attachment_resolve') {
        return { kind: 'resolved', path: 'Media/manual.pdf', renderKind: 'file' }
      }
      return null
    })
    setBridge({ invoke, invokeBinary: async () => null, listen: async () => () => {} })
    render(
      <AttachmentCatalogProvider generation={7}>
        <Host generation={7} path="Projects/Plan.md" />
      </AttachmentCatalogProvider>,
    )
    await waitFor(() => expect(persistence!.attachmentCatalogRevision).toBe(1))

    expect(persistence!.resolveImageUrl('./images/photo%20one.png')).toBe(
      `reflect-asset://localhost/${encodeURIComponent('7/Projects/images/photo one.png')}?reflect-catalog=1`,
    )
    expect(persistence!.resolveFileLink(fileLink('../Media/manual.pdf'))).toBe(true)
    expect(
      persistence!.resolveWikiEmbed({
        target: 'diagram.png',
        display: 'Diagram',
        width: null,
        height: null,
      }),
    ).toEqual({ kind: 'image', src: '/Media/diagram.png', alt: 'Diagram' })
    await expect(persistence!.resolveFileInfo('../Media/manual.pdf')).resolves.toEqual({ size: 80 })

    expect(
      persistence!.resolveFileLinkFromSource(
        'Archive/2025/Review.md',
        fileLink('../../Media/manual.pdf'),
      ),
    ).toBe(true)
    expect(
      persistence!.resolveWikiEmbedFromSource('Archive/2025/Review.md', {
        target: 'diagram.png',
        display: '',
        width: null,
        height: null,
      }),
    ).toEqual({ kind: 'image', src: '/Media/diagram.png' })
    await expect(
      persistence!.resolveFileInfoFromSource(
        'Archive/2025/Review.md',
        '../../Media/manual.pdf',
      ),
    ).resolves.toEqual({ size: 80 })
    await persistence!.openAttachmentFromSource(
      'Archive/2025/Review.md',
      '../../Media/manual.pdf',
    )
    expect(invoke).toHaveBeenCalledWith(
      'attachment_resolve',
      expect.objectContaining({
        request: expect.objectContaining({
          sourcePath: 'Archive/2025/Review.md',
          reference: '../../Media/manual.pdf',
        }),
      }),
    )
    expect(invoke).toHaveBeenCalledWith('asset_open', {
      path: 'Media/manual.pdf',
      generation: 7,
    })
  })

  it('leaves missing or ambiguous attachments literal and falls back to note embeds', async () => {
    setBridge({
      invoke: async (command: string) =>
        command === 'list_attachments'
          ? [
              { path: 'Media/photo.png', size: 1, modifiedMs: 1 },
              { path: 'Other/PHOTO.PNG', size: 1, modifiedMs: 1 },
            ]
          : null,
      listen: async () => () => {},
    })
    render(
      <AttachmentCatalogProvider generation={7}>
        <Host generation={7} path="Projects/Plan.md" />
      </AttachmentCatalogProvider>,
    )
    await waitFor(() => expect(persistence!.attachmentCatalogRevision).toBe(1))

    const embed = (target: string) =>
      persistence!.resolveWikiEmbed({ target, display: '', width: null, height: null })
    expect(embed('photo.png')).toBeUndefined()
    expect(embed('missing.png')).toBeUndefined()
    expect(embed('People/Ada')).toEqual({ kind: 'note' })
    expect(embed('../.private/secret')).toBeUndefined()
  })

  it('round-trips encoded canonical paths through wiki rendering and OS open', async () => {
    const attachmentPath = 'Media/资料/photo#1 100%?.png'
    const invoke = vi.fn(async (command: string) => {
      if (command === 'list_attachments') {
        return [{ path: attachmentPath, size: 40, modifiedMs: 1 }]
      }
      if (command === 'attachment_resolve') {
        return { kind: 'resolved', path: attachmentPath, renderKind: 'image' }
      }
      return null
    })
    setBridge({ invoke, listen: async () => () => {} })
    render(
      <AttachmentCatalogProvider generation={7}>
        <Host generation={7} path="Projects/Plan.md" />
      </AttachmentCatalogProvider>,
    )
    await waitFor(() => expect(persistence!.attachmentCatalogRevision).toBe(1))

    const embed = persistence!.resolveWikiEmbed({
      target: 'Media/%E8%B5%84%E6%96%99/photo%231%20100%25%3F.png',
      display: '',
      width: null,
      height: null,
    })
    expect(embed).toEqual({
      kind: 'image',
      src: '/Media/%E8%B5%84%E6%96%99/photo%231%20100%25%3F.png',
    })
    if (embed?.kind !== 'image' || embed.src === undefined) {
      throw new Error('expected a resolved wiki image')
    }
    expect(persistence!.resolveImageUrl(embed.src)).toContain(
      encodeURIComponent(`7/${attachmentPath}`),
    )

    await persistence!.openAsset(attachmentPath)
    expect(invoke).toHaveBeenCalledWith(
      'attachment_resolve',
      expect.objectContaining({
        request: expect.objectContaining({
          reference: '/Media/%E8%B5%84%E6%96%99/photo%231%20100%25%3F.png',
        }),
      }),
    )
    expect(invoke).toHaveBeenCalledWith('asset_open', {
      path: attachmentPath,
      generation: 7,
    })
  })

  it('refreshes sizes and retries iCloud materialization after catalog transitions', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let files: readonly FileMeta[] = [
      { path: 'Media/remote.png', size: 10, modifiedMs: 1, placeholder: true },
      { path: 'Media/manual.pdf', size: 20, modifiedMs: 1 },
    ]
    const invoke = vi.fn(async (command: string) => {
      if (command === 'list_attachments') {
        return files
      }
      if (command === 'attachment_resolve') {
        return { kind: 'unavailable', path: 'Media/remote.png' }
      }
      return null
    })
    setBridge({ invoke, listen: async () => () => {} })
    render(
      <AttachmentCatalogProvider generation={7}>
        <Host generation={7} path="Projects/Plan.md" />
      </AttachmentCatalogProvider>,
    )
    await waitFor(() => expect(persistence!.attachmentCatalogRevision).toBe(1))

    expect(persistence!.resolveImageUrl('/Media/remote.png')).toContain('reflect-catalog=1')
    persistence!.resolveImageUrl('/Media/remote.png')
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([command]) => command === 'attachment_resolve')).toHaveLength(
        1,
      ),
    )
    now += 10_001
    persistence!.resolveImageUrl('/Media/remote.png')
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([command]) => command === 'attachment_resolve')).toHaveLength(
        2,
      ),
    )

    await expect(persistence!.resolveFileInfo('/Media/manual.pdf')).resolves.toEqual({ size: 20 })
    files = [
      { path: 'Media/remote.png', size: 30, modifiedMs: 2 },
      { path: 'Media/manual.pdf', size: 40, modifiedMs: 2 },
    ]
    act(() => emitFileChanges([{ path: 'Media/remote.png', kind: 'upsert' }]))
    await waitFor(() => expect(persistence!.attachmentCatalogRevision).toBe(2))
    expect(persistence!.resolveImageUrl('/Media/remote.png')).toContain('reflect-catalog=2')
    await expect(persistence!.resolveFileInfo('/Media/manual.pdf')).resolves.toEqual({ size: 40 })

    files = [
      { path: 'Media/remote.png', size: 10, modifiedMs: 3, placeholder: true },
      { path: 'Media/manual.pdf', size: 40, modifiedMs: 2 },
    ]
    act(() => emitFileChanges([{ path: 'Media/remote.png', kind: 'upsert' }]))
    await waitFor(() => expect(persistence!.attachmentCatalogRevision).toBe(3))
    persistence!.resolveImageUrl('/Media/remote.png')
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([command]) => command === 'attachment_resolve')).toHaveLength(
        3,
      ),
    )
  })
})

describe('vaultAttachmentReference', () => {
  it('encodes each canonical path segment exactly once', () => {
    expect(vaultAttachmentReference('Media/photo#1 100%?.png')).toBe(
      '/Media/photo%231%20100%25%3F.png',
    )
    expect(vaultAttachmentReference('资料/你好.png')).toBe(
      '/%E8%B5%84%E6%96%99/%E4%BD%A0%E5%A5%BD.png',
    )
  })
})

/** A bridge whose upload commands succeed and whose `dir_list` serves `entries`. */
function installListingBridge(
  entries: Array<{ path: string; size: number }>,
): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (command: string, args: Record<string, unknown>) =>
    command === 'dir_list'
      ? entries.map((entry) => ({ ...entry, modifiedMs: 0 }))
      : command === 'asset_upload_begin'
        ? 'upload-1'
        : command === 'asset_upload_commit'
          ? `assets/${args['desiredName'] as string}`
          : null,
  )
  setBridge({ invoke, invokeBinary: async () => null, listen: async () => () => {} })
  return invoke
}

describe('useAssetPersistence resolveFileInfo', () => {
  it('lists the assets directory once for a burst of pills', async () => {
    const invoke = installListingBridge([
      { path: 'assets/q3-report.pdf', size: 1234 },
      { path: 'assets/manual.pdf', size: 5678 },
    ])
    render(<Host generation={3} />)

    const [report, archive] = await Promise.all([
      persistence!.resolveFileInfo('assets/q3-report.pdf'),
      persistence!.resolveFileInfo('assets/manual.pdf'),
    ])

    expect(report).toEqual({ size: 1234 })
    expect(archive).toEqual({ size: 5678 })
    expect(invoke.mock.calls.filter(([command]) => command === 'dir_list')).toHaveLength(1)
  })

  it('serves a just-saved file from the save itself, without a listing', async () => {
    const invoke = installListingBridge([])
    render(<Host generation={3} />)

    await act(async () => {
      await persistence!.saveFile(fileOf('Q3 Report.PDF', 'application/pdf', 1234))
    })

    await expect(persistence!.resolveFileInfo('assets/q3-report.pdf')).resolves.toEqual({
      size: 1234,
    })
    expect(invoke.mock.calls.filter(([command]) => command === 'dir_list')).toHaveLength(0)
  })

  it('declines remote or unsafe hrefs without touching the bridge', async () => {
    const invoke = installListingBridge([])
    render(<Host generation={3} />)

    await expect(persistence!.resolveFileInfo('https://example.com/q3.pdf')).resolves.toBeUndefined()
    await expect(persistence!.resolveFileInfo('assets/../secrets.env')).resolves.toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('returns undefined for an asset missing from the listing', async () => {
    installListingBridge([{ path: 'assets/other.pdf', size: 9 }])
    render(<Host generation={3} />)

    await expect(persistence!.resolveFileInfo('assets/gone.pdf')).resolves.toBeUndefined()
  })

  it('declines without a graph session', async () => {
    const invoke = installListingBridge([{ path: 'assets/q3.pdf', size: 9 }])
    render(<Host generation={null} />)

    await expect(persistence!.resolveFileInfo('assets/q3.pdf')).resolves.toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('degrades to no size when the assets listing fails', async () => {
    setBridge({
      invoke: async () => {
        throw { kind: 'io', message: 'bridge down' }
      },
      invokeBinary: async () => null,
      listen: async () => () => {},
    })
    render(<Host generation={3} />)

    await expect(persistence!.resolveFileInfo('assets/q3.pdf')).resolves.toBeUndefined()
  })

  it('never serves a listing that lands after the graph session switched', async () => {
    let resolveListing: ((entries: unknown) => void) | null = null
    setBridge({
      invoke: (command: string) =>
        command === 'dir_list'
          ? new Promise((resolve) => {
              resolveListing = resolve
            })
          : Promise.resolve(null),
      invokeBinary: async () => null,
      listen: async () => () => {},
    })
    const view = render(<Host generation={3} />)

    const staleLookup = persistence!.resolveFileInfo('assets/q3.pdf')
    await waitFor(() => expect(resolveListing).not.toBeNull())
    const resolveStale = resolveListing!
    resolveListing = null

    // The user switches graphs; the old graph's listing then lands.
    view.rerender(<Host generation={4} />)
    resolveStale([{ path: 'assets/q3.pdf', size: 999, modifiedMs: 0 }])
    await staleLookup

    // The new session lists afresh instead of serving the stale size.
    const freshLookup = persistence!.resolveFileInfo('assets/q3.pdf')
    await waitFor(() => expect(resolveListing).not.toBeNull())
    resolveListing!([{ path: 'assets/q3.pdf', size: 111, modifiedMs: 0 }])
    await expect(freshLookup).resolves.toEqual({ size: 111 })
  })
})

/** A bridge whose appends fail until `heal()` is called. */
function installFailingBridge(): { heal: () => void } {
  const state = { failing: true }
  const invoke = vi.fn(async (command: string, args: Record<string, unknown>) =>
    command === 'asset_upload_begin'
      ? 'upload-1'
      : command === 'asset_upload_commit'
        ? `assets/${args['desiredName'] as string}`
        : null,
  )
  setBridge({
    invoke,
    invokeBinary: async () => {
      if (state.failing) {
        throw { kind: 'io', message: 'disk full' }
      }
      return null
    },
    listen: async () => () => {},
  })
  return {
    heal: () => {
      state.failing = false
    },
  }
}

describe('useAssetPersistence errors', () => {
  it('owns save failures — never throws — keyed by how the file was named', async () => {
    const bridge = installFailingBridge()
    render(<Host generation={3} />)

    // A pasted image fails as an image…
    await act(async () => {
      await expect(persistence!.saveFile(fileOf('a.png', 'image/png'))).resolves.toBeNull()
    })
    expect(persistence!.saveError).toEqual({ kind: 'image', message: 'disk full' })

    // …a supported document fails as a file.
    await act(async () => {
      await expect(
        persistence!.saveFile(fileOf('scan.pdf', 'application/pdf')),
      ).resolves.toBeNull()
    })
    expect(persistence!.saveError).toEqual({ kind: 'file', message: 'disk full' })

    // The next success clears the banner.
    bridge.heal()
    await act(async () => {
      await persistence!.saveFile(fileOf('b.pdf', 'application/pdf'))
    })
    expect(persistence!.saveError).toBeNull()
  })

  it('drops a failure that lands after the note switched', async () => {
    let failLateAppend: (() => void) | null = null
    const invoke = vi.fn(async (command: string) =>
      command === 'asset_upload_begin' ? 'upload-1' : null,
    )
    setBridge({
      invoke,
      invokeBinary: () =>
        new Promise((_resolve, reject) => {
          failLateAppend = () => reject({ kind: 'io', message: 'late failure' })
        }),
      listen: async () => () => {},
    })
    const view = render(<Host generation={3} path="notes/a.md" />)

    let savePromise: Promise<string | null> | null = null
    act(() => {
      savePromise = persistence!.saveFile(fileOf('slow.pdf', 'application/pdf'))
    })
    await waitFor(() => expect(failLateAppend).not.toBeNull())

    // The user moves on; the stream then fails for the note they left.
    view.rerender(<Host generation={3} path="notes/b.md" />)
    await act(async () => {
      failLateAppend!()
      await savePromise
    })

    await expect(savePromise).resolves.toBeNull()
    expect(persistence!.saveError).toBeNull()
  })

  it('declines a successful paste that lands after the source path changed', async () => {
    let finishCommit: ((path: string) => void) | null = null
    setBridge({
      invoke: (command: string) => {
        if (command === 'asset_upload_begin') {
          return Promise.resolve('upload-1')
        }
        if (command === 'asset_upload_commit') {
          return new Promise((resolve) => {
            finishCommit = resolve
          })
        }
        return Promise.resolve(null)
      },
      invokeBinary: async () => null,
      listen: async () => () => {},
    })
    const view = render(<Host generation={3} path="Projects/old.md" />)

    let savePromise: Promise<string | null> | null = null
    act(() => {
      savePromise = persistence!.saveFile(fileOf('slow.pdf', 'application/pdf'))
    })
    await waitFor(() => expect(finishCommit).not.toBeNull())
    view.rerender(<Host generation={3} path="Archive/new.md" />)
    await act(async () => {
      finishCommit?.('assets/slow.pdf')
      await savePromise
    })

    await expect(savePromise).resolves.toBeNull()
  })

})
