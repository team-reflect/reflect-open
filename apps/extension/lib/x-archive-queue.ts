import { archiveJobSchema } from '@reflect/core/x-archive'
import { sendArchiveMessage } from './x-native'
import { downloadJob, finishDownload } from './x-download'
import {
  getRecords, putRecord, removeDownload,
  type CaptureRecord, type DownloadRecord,
} from './x-download-store'

let running: Promise<void> | undefined
export async function enqueueArchivedCapture(envelope: { id: string }): Promise<void> {
  await putRecord('captures', { id: envelope.id, envelope })
}
export function flushArchivedCaptures(): Promise<void> {
  if (running) return running
  running = run().finally(() => { running = undefined })
  return running
}
async function run() {
  const captures = await getRecords<CaptureRecord>('captures')
  const bindings = new Set<string>()
  try {
    const current = await sendArchiveMessage({ op: 'work.bind' })
    if (current.binding) bindings.add(current.binding)
  } catch {}
  for (const capture of captures) {
    if (capture.binding) { bindings.add(capture.binding); continue }
    try {
      const response = await sendArchiveMessage({ op: 'capture.put', envelope: capture.envelope })
      if (!response.binding) throw new Error('missing-binding')
      await putRecord('captures', { ...capture, binding: response.binding })
      bindings.add(response.binding)
    } catch (error) {
      await putRecord('captures', { ...capture, error: error instanceof Error ? error.message : 'native-failed' })
    }
  }
  for (const record of await getRecords<DownloadRecord>('downloads')) {
    bindings.add(record.binding)
    if (record.complete) { await finishDownload(record).catch(() => {}); continue }
    if (record.job.lease) {
      await sendArchiveMessage({
        op: 'asset.abort', binding: record.binding, jobId: record.job.id,
        lease: record.job.lease, reason: 'network',
      }).catch(() => {})
    }
    await removeDownload(record.id)
  }
  for (const binding of bindings) {
    // Bound one worker invocation. A periodic alarm drains the remainder.
    for (let count = 0; count < 8; count++) {
      const response = await sendArchiveMessage({ op: 'work.pull', binding })
      if (response.data === null) break
      const job = archiveJobSchema.parse(response.data)
      await downloadJob(binding, job).catch(() => {})
    }
  }
}

