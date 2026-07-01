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

function Host({ generation }: { generation: number | null }): ReactNode {
  persistence = useAttachmentPersistence(generation)
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
