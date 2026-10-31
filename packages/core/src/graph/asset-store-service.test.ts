import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import {
  createTestClockService,
  createTestFileChangeService,
  createTestIpcBridgeService,
} from '../testing/index.ts'
import { createAssetStoreService } from './asset-store-service.ts'

function bytesOf(size: number, fill: number): Blob {
  return new Blob([new Uint8Array(size).fill(fill)])
}

function setup(options?: { binary?: boolean }) {
  const ipc = createTestIpcBridgeService({ binary: options?.binary ?? true })
  const fileChanges = createTestFileChangeService()
  const clock = createTestClockService({ now: 9_000 })
  return { ipc, fileChanges, assetStore: createAssetStoreService({ ipc, clock, fileChanges }) }
}

describe('uploadBlob', () => {
  it('streams begin → chunked appends → commit and returns the final path', async () => {
    const { ipc, fileChanges, assetStore } = setup()
    ipc.onCommand('asset_upload_begin', () => 'upload-1')
    ipc.onCommand('asset_upload_commit', () => 'assets/report.pdf')
    const chunks: { size: number; headers: Record<string, string> }[] = []
    ipc.onBinaryCommand('asset_upload_append', (body, headers) => {
      chunks.push({ size: body.byteLength, headers })
      return null
    })

    // 5 MiB: crosses the 4 MiB chunk size, so exactly two appends.
    const path = await assetStore.uploadBlob('report.pdf', bytesOf(5 * 1024 * 1024, 7), 3)

    expect(path).toBe('assets/report.pdf')
    expect(chunks).toEqual([
      { size: 4 * 1024 * 1024, headers: { 'x-upload-id': 'upload-1' } },
      { size: 1024 * 1024, headers: { 'x-upload-id': 'upload-1' } },
    ])
    expect(ipc.calls().map(({ command }) => command)).toEqual([
      'asset_upload_begin',
      'asset_upload_append',
      'asset_upload_append',
      'asset_upload_commit',
    ])
    expect(ipc.calls()[0]?.args).toEqual({ generation: 3 })
    expect(ipc.calls()[3]?.args).toEqual({
      id: 'upload-1',
      desiredName: 'report.pdf',
      generation: 3,
    })
    expect(fileChanges.ownWrites()).toEqual([['assets/report.pdf']])
  })

  it('aborts the upload and rethrows when an append fails', async () => {
    const { ipc, fileChanges, assetStore } = setup()
    ipc.onCommand('asset_upload_begin', () => 'upload-9')
    ipc.onCommand('asset_upload_abort', () => null)
    ipc.onBinaryCommand('asset_upload_append', () => {
      throw new AppError('io', 'disk full')
    })

    await expect(assetStore.uploadBlob('big.zip', bytesOf(16, 1), 2)).rejects.toMatchObject({
      kind: 'io',
      message: 'disk full',
    })
    expect(ipc.calls().map(({ command }) => command)).toEqual([
      'asset_upload_begin',
      'asset_upload_append',
      'asset_upload_abort',
    ])
    expect(ipc.calls()[2]?.args).toEqual({ id: 'upload-9' })
    expect(fileChanges.ownWrites()).toEqual([])
  })

  it('fails loudly when the bridge has no binary transport', async () => {
    const { ipc, assetStore } = setup({ binary: false })
    ipc.onCommand('asset_upload_begin', () => 'upload-2')
    ipc.onCommand('asset_upload_abort', () => null)

    await expect(assetStore.uploadBlob('a.pdf', bytesOf(8, 0), 1)).rejects.toMatchObject({
      kind: 'io',
    })
    expect(ipc.calls().at(-1)).toEqual({
      command: 'asset_upload_abort',
      args: { id: 'upload-2' },
    })
  })
})

describe('uploadToPath', () => {
  it('streams to the exact path when the transport carries binary bodies', async () => {
    const { ipc, fileChanges, assetStore } = setup()
    ipc.onCommand('asset_upload_begin', () => 'upload-3')
    ipc.onCommand('asset_upload_commit_path', () => null)
    ipc.onBinaryCommand('asset_upload_append', () => null)

    await assetStore.uploadToPath('audio-memos/a.webm', bytesOf(4, 1), 5)

    expect(ipc.calls().at(-1)).toEqual({
      command: 'asset_upload_commit_path',
      args: { id: 'upload-3', path: 'audio-memos/a.webm', generation: 5 },
    })
    expect(fileChanges.ownWrites()).toEqual([['audio-memos/a.webm']])
  })

  it('falls back to base64 without a binary transport', async () => {
    const { ipc, fileChanges, assetStore } = setup({ binary: false })
    ipc.onCommand('asset_write', () => null)

    await assetStore.uploadToPath('audio-memos/a.webm', new Blob(['audio']), 5)

    expect(ipc.calls()).toEqual([
      {
        command: 'asset_write',
        args: { path: 'audio-memos/a.webm', contentsBase64: btoa('audio'), generation: 5 },
      },
    ])
    expect(fileChanges.ownWrites()).toEqual([['audio-memos/a.webm']])
  })
})

describe('readBytes', () => {
  it('reads a raw binary response when the transport carries binary bodies', async () => {
    const { ipc, assetStore } = setup()
    ipc.onCommand('asset_read_binary', () => new Uint8Array([1, 2, 3]).buffer)

    await expect(assetStore.readBytes('assets/a.png', 4)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(ipc.calls()).toEqual([
      { command: 'asset_read_binary', args: { path: 'assets/a.png', generation: 4 } },
    ])
  })

  it('falls back to base64 without a binary transport', async () => {
    const { ipc, assetStore } = setup({ binary: false })
    ipc.onCommand('asset_read', () => btoa('abc'))

    await expect(assetStore.readBytes('assets/a.png', 4)).resolves.toEqual(
      new TextEncoder().encode('abc'),
    )
    expect(ipc.calls().map(({ command }) => command)).toEqual(['asset_read'])
  })
})

describe('createAssetStoreService', () => {
  it('copies by OS path through the generation-pinned command', async () => {
    const { ipc, fileChanges, assetStore } = setup()
    ipc.onCommand('asset_import', () => 'assets/q3-report-2.pdf')

    const path = await assetStore.importFile(
      '/Users/me/Downloads/Q3 report.pdf',
      'q3-report.pdf',
      5,
    )

    expect(path).toBe('assets/q3-report-2.pdf')
    expect(ipc.calls()).toEqual([
      {
        command: 'asset_import',
        args: {
          sourcePath: '/Users/me/Downloads/Q3 report.pdf',
          desiredName: 'q3-report.pdf',
          generation: 5,
        },
      },
    ])
    expect(fileChanges.ownWrites()).toEqual([['assets/q3-report-2.pdf']])
  })

  it('sends the remaining operations as their commands with the graph generation', async () => {
    const { ipc, fileChanges, assetStore } = setup()
    for (const command of [
      'asset_open',
      'asset_reveal',
      'audio_memo_delete',
      'audio_memo_import',
      'transcript_cache_write',
    ]) {
      ipc.onCommand(command, () => null)
    }
    ipc.onCommand('transcript_cache_read', () => 'cached')

    await assetStore.open('assets/cat.png', 7)
    await assetStore.reveal('assets/cat.png', 7)
    await assetStore.deleteAudioMemo('audio-memos/a.webm', 7)
    await assetStore.importAudioMemo('/tmp/a.webm', 'audio-memos/a.webm', 7)
    await assetStore.writeTranscriptCache('a.json', '{}', 7)
    await expect(assetStore.readTranscriptCache('a.json', 7)).resolves.toBe('cached')

    expect(ipc.calls()).toEqual([
      { command: 'asset_open', args: { path: 'assets/cat.png', generation: 7 } },
      { command: 'asset_reveal', args: { path: 'assets/cat.png', generation: 7 } },
      { command: 'audio_memo_delete', args: { path: 'audio-memos/a.webm', generation: 7 } },
      {
        command: 'audio_memo_import',
        args: { sourcePath: '/tmp/a.webm', path: 'audio-memos/a.webm', generation: 7 },
      },
      {
        command: 'transcript_cache_write',
        args: { name: 'a.json', contents: '{}', generation: 7 },
      },
      { command: 'transcript_cache_read', args: { name: 'a.json', generation: 7 } },
    ])
    expect(fileChanges.ownWrites()).toEqual([['audio-memos/a.webm']])
  })
})
