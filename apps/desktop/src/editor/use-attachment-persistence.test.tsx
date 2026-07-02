import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { setBridge } from '@reflect/core'
import {
  LARGE_ATTACHMENT_BYTES,
  useAttachmentPersistence,
  type AttachmentPersistence,
} from './use-attachment-persistence'

let persistence: AttachmentPersistence | null = null

function Host({
  generation,
  path = 'notes/a.md',
}: {
  generation: number | null
  path?: string
}): ReactNode {
  persistence = useAttachmentPersistence(path, generation)
  return null
}

/** A bridge whose upload commands succeed and record every invocation. */
function installUploadBridge(): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (command: string) =>
    command === 'asset_upload_begin'
      ? 'upload-1'
      : command === 'asset_upload_commit'
        ? 'assets/q3-report.pdf'
        : null,
  )
  setBridge({ invoke, invokeBinary: async () => null, listen: async () => () => {} })
  return invoke
}

function fileOfSize(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf' })
}

afterEach(() => {
  setBridge(null)
  persistence = null
})

describe('useAttachmentPersistence', () => {
  it('streams a small file under its sanitized original name', async () => {
    const invoke = installUploadBridge()
    render(<Host generation={3} />)

    let path: string | null = null
    await act(async () => {
      path = await persistence!.saveAttachment(fileOfSize('Q3 Report.PDF', 16))
    })

    expect(path).toBe('assets/q3-report.pdf')
    expect(invoke).toHaveBeenCalledWith('asset_upload_commit', {
      id: 'upload-1',
      desiredName: 'q3-report.pdf',
      generation: 3,
    })
    expect(persistence!.pendingLargeAttachment).toBeNull()
  })

  it('declines without a graph session', async () => {
    const invoke = installUploadBridge()
    render(<Host generation={null} />)

    let path: string | null = 'sentinel'
    await act(async () => {
      path = await persistence!.saveAttachment(fileOfSize('a.pdf', 16))
    })

    expect(path).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('pauses a large file on the confirm and saves when approved', async () => {
    const invoke = installUploadBridge()
    render(<Host generation={3} />)

    const large = fileOfSize('video.mov', LARGE_ATTACHMENT_BYTES + 1)
    let pathPromise: Promise<string | null> | null = null
    act(() => {
      pathPromise = persistence!.saveAttachment(large)
    })

    expect(persistence!.pendingLargeAttachment?.file).toBe(large)
    expect(invoke).not.toHaveBeenCalledWith('asset_upload_begin', expect.anything())

    await act(async () => {
      persistence!.pendingLargeAttachment!.respond(true)
      await pathPromise
    })

    expect(persistence!.pendingLargeAttachment).toBeNull()
    await expect(pathPromise).resolves.toBe('assets/q3-report.pdf')
  })

  it('drops a large file when the confirm is declined', async () => {
    const invoke = installUploadBridge()
    render(<Host generation={3} />)

    let pathPromise: Promise<string | null> | null = null
    act(() => {
      pathPromise = persistence!.saveAttachment(
        fileOfSize('video.mov', LARGE_ATTACHMENT_BYTES + 1),
      )
    })
    await act(async () => {
      persistence!.pendingLargeAttachment!.respond(false)
      await pathPromise
    })

    await expect(pathPromise).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('asset_upload_begin', expect.anything())
  })

  it('queues a second large file behind the open confirm instead of overwriting it', async () => {
    installUploadBridge()
    render(<Host generation={3} />)

    const first = fileOfSize('one.mov', LARGE_ATTACHMENT_BYTES + 1)
    const second = fileOfSize('two.mov', LARGE_ATTACHMENT_BYTES + 1)
    let firstPromise: Promise<string | null> | null = null
    let secondPromise: Promise<string | null> | null = null
    act(() => {
      firstPromise = persistence!.saveAttachment(first)
      secondPromise = persistence!.saveAttachment(second)
    })

    // Only the first file holds the dialog slot.
    expect(persistence!.pendingLargeAttachment?.file).toBe(first)

    await act(async () => {
      persistence!.pendingLargeAttachment!.respond(false)
      await firstPromise
    })
    await expect(firstPromise).resolves.toBeNull()

    // The second confirm takes the slot only after the first resolved.
    expect(persistence!.pendingLargeAttachment?.file).toBe(second)
    await act(async () => {
      persistence!.pendingLargeAttachment!.respond(true)
      await secondPromise
    })
    await expect(secondPromise).resolves.toBe('assets/q3-report.pdf')
  })

  it('declines pending and queued confirms and clears the error on a note switch', async () => {
    const invoke = installUploadBridge()
    const view = render(<Host generation={3} path="notes/a.md" />)

    let firstPromise: Promise<string | null> | null = null
    let secondPromise: Promise<string | null> | null = null
    act(() => {
      persistence!.onAttachmentSaveError({ kind: 'io', message: 'old note error' })
      firstPromise = persistence!.saveAttachment(
        fileOfSize('one.mov', LARGE_ATTACHMENT_BYTES + 1),
      )
      secondPromise = persistence!.saveAttachment(
        fileOfSize('two.mov', LARGE_ATTACHMENT_BYTES + 1),
      )
    })
    expect(persistence!.pendingLargeAttachment).not.toBeNull()

    await act(async () => {
      view.rerender(<Host generation={3} path="notes/b.md" />)
    })

    // The old note's confirms resolve declined — nothing written, no dialog
    // or error surviving into the new note.
    await expect(firstPromise).resolves.toBeNull()
    await expect(secondPromise).resolves.toBeNull()
    expect(persistence!.pendingLargeAttachment).toBeNull()
    expect(persistence!.saveError).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('asset_upload_begin', expect.anything())
  })

  it('declines a pending confirm when the graph switches under the same path', async () => {
    const invoke = installUploadBridge()
    const view = render(<Host generation={3} path="daily/2026-07-02.md" />)

    let pathPromise: Promise<string | null> | null = null
    act(() => {
      pathPromise = persistence!.saveAttachment(
        fileOfSize('one.mov', LARGE_ATTACHMENT_BYTES + 1),
      )
    })
    expect(persistence!.pendingLargeAttachment).not.toBeNull()

    // Same routed note, different graph session (daily paths exist in every
    // graph): the confirm belongs to the old graph and must not survive.
    await act(async () => {
      view.rerender(<Host generation={4} path="daily/2026-07-02.md" />)
    })

    await expect(pathPromise).resolves.toBeNull()
    expect(persistence!.pendingLargeAttachment).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('asset_upload_begin', expect.anything())
  })

  it('surfaces reported save errors and clears them on the next success', async () => {
    installUploadBridge()
    render(<Host generation={3} />)

    act(() => {
      persistence!.onAttachmentSaveError({ kind: 'io', message: 'disk full' })
    })
    expect(persistence!.saveError).toBe('disk full')

    await act(async () => {
      await persistence!.saveAttachment(fileOfSize('a.pdf', 16))
    })
    expect(persistence!.saveError).toBeNull()
  })
})
