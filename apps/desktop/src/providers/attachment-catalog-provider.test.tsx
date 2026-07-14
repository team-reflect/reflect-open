import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { emitFileChanges, setBridge, type FileMeta } from '@reflect/core'
import {
  AttachmentCatalogProvider,
  useAttachmentCatalog,
} from './attachment-catalog-provider'

let catalog: ReturnType<typeof useAttachmentCatalog> = null

function Probe(): ReactNode {
  catalog = useAttachmentCatalog()
  return null
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | null = null
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === null) {
        throw new Error('deferred promise was not initialized')
      }
      resolvePromise(value)
    },
  }
}

afterEach(() => {
  cleanup()
  setBridge(null)
  vi.restoreAllMocks()
  catalog = null
})

describe('AttachmentCatalogProvider', () => {
  it('refreshes after supported filesystem changes and ignores unrelated files', async () => {
    let files: readonly FileMeta[] = [
      { path: 'Media/first.png', size: 1, modifiedMs: 1 },
    ]
    const invoke = vi.fn(async (command: string) =>
      command === 'list_attachments' ? files : null,
    )
    setBridge({ invoke, listen: async () => () => {} })
    render(
      <AttachmentCatalogProvider generation={4}>
        <Probe />
      </AttachmentCatalogProvider>,
    )

    await waitFor(() => expect(catalog?.revision).toBe(1))
    expect(
      catalog?.resolve({
        sourcePath: 'Plan.md',
        reference: 'first.png',
        referenceKind: 'wikiEmbed',
      }),
    ).toEqual({ kind: 'resolved', path: 'Media/first.png', renderKind: 'image' })

    act(() => emitFileChanges([{ path: 'Archive/readme.txt', kind: 'upsert' }]))
    expect(invoke).toHaveBeenCalledTimes(1)

    act(() => emitFileChanges([{ path: 'Media/first.png', kind: 'upsert' }]))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(catalog?.revision).toBe(1)

    files = [{ path: 'Media/second.pdf', size: 2, modifiedMs: 2 }]
    act(() => emitFileChanges([{ path: 'Media/second.pdf', kind: 'upsert' }]))
    await waitFor(() => expect(catalog?.revision).toBe(2))
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(
      catalog?.resolve({
        sourcePath: 'Plan.md',
        reference: 'second.pdf',
        referenceKind: 'wikiEmbed',
      }),
    ).toEqual({ kind: 'resolved', path: 'Media/second.pdf', renderKind: 'file' })
  })

  it('never lets an older manifest request overwrite a newer refresh', async () => {
    const first = deferred<readonly FileMeta[]>()
    const second = deferred<readonly FileMeta[]>()
    let request = 0
    setBridge({
      invoke: async (command: string) => {
        if (command !== 'list_attachments') {
          return null
        }
        request += 1
        return request === 1 ? first.promise : second.promise
      },
      listen: async () => () => {},
    })
    render(
      <AttachmentCatalogProvider generation={4}>
        <Probe />
      </AttachmentCatalogProvider>,
    )
    await waitFor(() => expect(request).toBe(1))

    act(() => emitFileChanges([{ path: 'Media/new.png', kind: 'upsert' }]))
    await waitFor(() => expect(request).toBe(2))
    await act(async () => {
      second.resolve([{ path: 'Media/new.png', size: 2, modifiedMs: 2 }])
      await second.promise
    })
    await waitFor(() => expect(catalog?.revision).toBe(1))

    await act(async () => {
      first.resolve([{ path: 'Media/stale.png', size: 1, modifiedMs: 1 }])
      await first.promise
    })
    expect(catalog?.revision).toBe(1)
    expect(
      catalog?.resolve({
        sourcePath: 'Plan.md',
        reference: 'new.png',
        referenceKind: 'wikiEmbed',
      }),
    ).toEqual({ kind: 'resolved', path: 'Media/new.png', renderKind: 'image' })
  })

  it('fails closed after a refresh error and recovers through ambiguity and eviction', async () => {
    let files: readonly FileMeta[] = [
      { path: 'Media/photo.png', size: 1, modifiedMs: 1 },
    ]
    let failRefresh = false
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    setBridge({
      invoke: async (command: string) => {
        if (command !== 'list_attachments') {
          return null
        }
        if (failRefresh) {
          throw new Error('catalog unavailable')
        }
        return files
      },
      listen: async () => () => {},
    })
    render(
      <AttachmentCatalogProvider generation={4}>
        <Probe />
      </AttachmentCatalogProvider>,
    )
    await waitFor(() => expect(catalog?.revision).toBe(1))

    failRefresh = true
    act(() => emitFileChanges([{ path: 'Other/photo.png', kind: 'upsert' }]))
    await waitFor(() => expect(catalog?.revision).toBe(2))
    expect(
      catalog?.resolve({
        sourcePath: 'Plan.md',
        reference: 'photo.png',
        referenceKind: 'wikiEmbed',
      }),
    ).toEqual({ kind: 'notFound' })
    expect(errorSpy).toHaveBeenCalled()

    failRefresh = false
    files = [
      { path: 'Media/photo.png', size: 1, modifiedMs: 1 },
      { path: 'Other/PHOTO.PNG', size: 2, modifiedMs: 2 },
    ]
    act(() => emitFileChanges([{ path: 'Other/PHOTO.PNG', kind: 'upsert' }]))
    await waitFor(() => expect(catalog?.revision).toBe(3))
    expect(
      catalog?.resolve({
        sourcePath: 'Plan.md',
        reference: 'photo.png',
        referenceKind: 'wikiEmbed',
      }),
    ).toEqual({ kind: 'ambiguous', paths: ['Media/photo.png', 'Other/PHOTO.PNG'] })

    files = [{ path: 'Media/photo.png', size: 0, modifiedMs: 3, placeholder: true }]
    act(() => emitFileChanges([{ path: 'Media/photo.png', kind: 'upsert' }]))
    await waitFor(() => expect(catalog?.revision).toBe(4))
    expect(
      catalog?.resolve({
        sourcePath: 'Plan.md',
        reference: 'photo.png',
        referenceKind: 'wikiEmbed',
      }),
    ).toEqual({ kind: 'unavailable', path: 'Media/photo.png' })

    errorSpy.mockRestore()
  })
})
