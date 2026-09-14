import type { ArchiveJob } from '@reflect/core/x-archive'
export interface DownloadRecord {
  id: string
  binding: string
  job: ArchiveJob
  bytes: number
  complete: boolean
  sha256?: string
  error?: string
}
export interface CaptureRecord { id: string; envelope: object; binding?: string; error?: string }

let opened: Promise<IDBDatabase> | undefined
function database(): Promise<IDBDatabase> {
  if (opened) return opened
  opened = new Promise((resolve, reject) => {
    const request = indexedDB.open('reflect-x-archive', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('captures', { keyPath: 'id' })
      request.result.createObjectStore('downloads', { keyPath: 'id' })
      request.result.createObjectStore('chunks', { keyPath: ['id', 'offset'] })
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); opened = undefined }
      resolve(request.result)
    }
    request.onerror = () => { opened = undefined; reject(request.error) }
  })
  return opened
}
export async function getRecords<T>(store: 'captures' | 'downloads'): Promise<T[]> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error)
  })
}
export async function putRecord(store: 'captures' | 'downloads', value: CaptureRecord | DownloadRecord) {
  const db = await database()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite')
    transaction.objectStore(store).put(value)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}
export async function saveChunk(record: DownloadRecord, offset: number, bytes: Uint8Array) {
  const db = await database()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['downloads', 'chunks'], 'readwrite')
    transaction.objectStore('chunks').put({ id: record.id, offset, bytes })
    transaction.objectStore('downloads').put(record)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}
export async function readChunks(id: string): Promise<Array<{ offset: number; bytes: Uint8Array }>> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction('chunks').objectStore('chunks')
      .getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
    request.onsuccess = () => resolve(request.result as Array<{ offset: number; bytes: Uint8Array }>)
    request.onerror = () => reject(request.error)
  })
}
export async function removeDownload(id: string) {
  const db = await database()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['downloads', 'chunks'], 'readwrite')
    transaction.objectStore('downloads').delete(id)
    transaction.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

