import { z } from 'zod'
import {
  VIDEO_MAX_BYTES,
  IMAGE_MAX_BYTES,
  ASSET_CHUNK_MAX_BYTES,
  archiveJobSchema,
  isValidUrl,
  type ArchiveJob,
} from '@reflect/core/x-archive'
import { sendArchiveMessage } from './x-native'
import {
  getRecords,
  putRecord,
  saveChunk,
  readChunks,
  removeDownload,
  type DownloadRecord,
} from './x-download-store'

function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let start = 0; start < bytes.length; start += 8192) {
    text += String.fromCharCode(...bytes.subarray(start, start + 8192))
  }
  return btoa(text)
}
async function checksum(chunks: Array<{ offset: number; bytes: Uint8Array }>, length: number) {
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of [...chunks].sort((a, b) => a.offset - b.offset)) {
    if (chunk.offset !== offset || offset + chunk.bytes.length > length)
      throw new Error('chunk-gap')
    bytes.set(chunk.bytes, offset)
    offset += chunk.bytes.length
  }
  if (offset !== length) throw new Error('chunk-gap')
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
export async function downloadJob(binding: string, job: ArchiveJob): Promise<void> {
  if (!job.lease || !isValidUrl(job.resource.url)) throw new Error('invalid-job')
  const id = binding + ':' + job.id
  const previous = (await getRecords<DownloadRecord>('downloads')).find((entry) => entry.id === id)
  if (previous?.complete && previous.sha256) {
    const rebound = { ...previous, job }
    await putRecord('downloads', rebound)
    await finishDownload(rebound)
    return
  }
  await removeDownload(id)
  let record: DownloadRecord = { id, binding, job, bytes: 0, complete: false }
  await putRecord('downloads', record)
  let limit = IMAGE_MAX_BYTES
  let failure:
    | 'network'
    | 'authentication'
    | 'source-missing'
    | 'format'
    | 'storage'
    | 'video-too-large' = 'network'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(job.resource.url, {
      credentials: 'include',
      redirect: 'error',
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) failure = 'authentication'
    else if (response.status === 404) failure = 'source-missing'
    if (!response.ok) throw new Error(failure)
    const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
    if (!['video/mp4', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime ?? '')) {
      failure = 'format'
      throw new Error(failure)
    }
    limit = mime === 'video/mp4' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limit) {
      failure = limit === VIDEO_MAX_BYTES ? 'video-too-large' : 'format'
      throw new Error(failure)
    }
    if (!response.body) {
      failure = 'format'
      throw new Error('empty-body')
    }
    reader = response.body.getReader()
    while (true) {
      failure = 'network'
      const part = await reader.read()
      if (part.done) break
      if (record.bytes + part.value.byteLength > limit) {
        failure = limit === VIDEO_MAX_BYTES ? 'video-too-large' : 'format'
        throw new Error(failure)
      }
      for (let start = 0; start < part.value.byteLength; start += ASSET_CHUNK_MAX_BYTES) {
        const chunk = part.value.slice(start, start + ASSET_CHUNK_MAX_BYTES)
        const offset = record.bytes
        record = { ...record, bytes: offset + chunk.byteLength }
        failure = 'storage'
        await saveChunk(record, offset, chunk)
        const response = await sendArchiveMessage({
          op: 'asset.append',
          binding,
          jobId: job.id,
          lease: job.lease,
          offset,
          data: toBase64(chunk),
        })
        const ack = z.object({ offset: z.number().int() }).parse(response.data)
        if (ack.offset !== record.bytes) throw new Error('offset-conflict')
      }
    }
    if (!record.bytes) {
      failure = 'format'
      throw new Error('empty-body')
    }
    failure = 'storage'
    const chunks = await readChunks(id)
    record = { ...record, complete: true, sha256: await checksum(chunks, record.bytes) }
    await putRecord('downloads', record)
    await finishDownload(record)
  } catch (error) {
    controller.abort()
    await reader?.cancel().catch(() => {})
    await putRecord('downloads', { ...record, error: failure })
    if (record.complete) throw error
    await sendArchiveMessage({
      op: 'asset.abort',
      binding,
      jobId: job.id,
      lease: job.lease,
      reason: failure,
    }).then(
      () => removeDownload(id),
      () => {},
    )
    throw error
  } finally {
    clearTimeout(timeout)
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}
export async function finishDownload(record: DownloadRecord) {
  if (!record.job.lease || !record.complete || !record.sha256) return
  const response = await sendArchiveMessage({
    op: 'asset.status',
    binding: record.binding,
    jobId: record.job.id,
  })
  const job = archiveJobSchema.parse(response.data)
  if (job.state === 'stored') {
    await removeDownload(record.id)
    return
  }
  if (job.state === 'unsupported' || (job.state === 'failed' && job.resource.error !== 'network')) {
    await removeDownload(record.id)
    return
  }
  if (job.lease !== record.job.lease) return
  for (const chunk of (await readChunks(record.id)).sort((a, b) => a.offset - b.offset)) {
    await sendArchiveMessage({
      op: 'asset.append',
      binding: record.binding,
      jobId: job.id,
      lease: record.job.lease,
      offset: chunk.offset,
      data: toBase64(chunk.bytes),
    })
  }
  await sendArchiveMessage({
    op: 'asset.commit',
    binding: record.binding,
    jobId: job.id,
    lease: record.job.lease,
    bytes: record.bytes,
    sha256: record.sha256,
  })
  await removeDownload(record.id)
}
