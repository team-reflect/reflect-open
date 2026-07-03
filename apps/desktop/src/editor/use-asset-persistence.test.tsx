import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { setBridge } from '@reflect/core'
import { resetOperations, useOperations, type Operation } from '@/lib/operations'
import {
  LARGE_FILE_BYTES,
  resolveAssetFileLink,
  useAssetPersistence,
  type AssetPersistence,
} from './use-asset-persistence'

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
  persistence = useAssetPersistence('/graph', generation, path)
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

    expect(saved).toMatch(/^assets\/pasted-\d+\.png$/)
  })

  it('keeps an attachment under its sanitized original name', async () => {
    installUploadBridge()
    render(<Host generation={3} />)

    let saved: string | null = null
    await act(async () => {
      saved = await persistence!.saveFile(fileOf('Q3 Report.PDF', 'application/pdf'))
    })

    expect(saved).toBe('assets/q3-report.pdf')
  })

  it('treats an image MIME without a known extension as a named attachment', async () => {
    installUploadBridge()
    render(<Host generation={3} />)

    let saved: string | null = null
    await act(async () => {
      saved = await persistence!.saveFile(fileOf('Scan 1.tiff', 'image/tiff'))
    })

    expect(saved).toBe('assets/scan-1.tiff')
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

    expect(saved).toBe('assets/huge.mov')
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

function fileLink(href: string): { href: string; label: string; title: string } {
  return { href, label: 'label', title: '' }
}

describe('resolveAssetFileLink', () => {
  it('claims safe graph-relative assets/ links only', () => {
    expect(resolveAssetFileLink(fileLink('assets/q3-report.pdf'))).toBe(true)
    expect(resolveAssetFileLink(fileLink('assets/sub/archive.zip'))).toBe(true)

    expect(resolveAssetFileLink(fileLink('https://example.com/q3.pdf'))).toBe(false)
    expect(resolveAssetFileLink(fileLink('notes/other.md'))).toBe(false)
    expect(resolveAssetFileLink(fileLink('assets/../secrets.env'))).toBe(false)
    expect(resolveAssetFileLink(fileLink('assets\\evil.pdf'))).toBe(false)
    expect(resolveAssetFileLink(fileLink('assets/'))).toBe(false)
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
      { path: 'assets/archive.zip', size: 5678 },
    ])
    render(<Host generation={3} />)

    const [report, archive] = await Promise.all([
      persistence!.resolveFileInfo('assets/q3-report.pdf'),
      persistence!.resolveFileInfo('assets/archive.zip'),
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

    // …an image MIME saved under its own name fails as a file (it was named
    // like an attachment, so its banner says so too).
    await act(async () => {
      await expect(persistence!.saveFile(fileOf('scan.tiff', 'image/tiff'))).resolves.toBeNull()
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

})
