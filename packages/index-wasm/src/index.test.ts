import { afterEach, expect, it } from 'vitest'

import { createWasmIndexBackend, WasmIndexError, type WasmIndexBackend } from './index.ts'

const NOTE = {
  path: 'notes/a.md',
  id: null,
  title: 'Alpha',
  titleKey: 'alpha',
  pathKey: 'notes/a',
  kind: 'note',
  dailyDate: null,
  isPrivate: false,
  isPinned: false,
  pinnedOrder: null,
  gistUrl: null,
  gistStale: false,
  fileHash: 'hash',
  mtime: 1,
  preview: '',
  hasContent: true,
  text: 'hello world',
  links: [],
  tags: [],
  aliases: [],
  claims: [],
  emails: [],
  assets: [],
  tasks: [],
}

let index: WasmIndexBackend

afterEach(() => {
  index.close()
})

function query(sql: string, params: unknown[] = []): unknown {
  return index.invoke('db_query', { sql, params })
}

it('writes a note and finds it with full-text search', () => {
  index = createWasmIndexBackend()
  const generation = index.invoke('index_open', {})
  index.invoke('index_apply', { note: NOTE, generation })

  expect(query('select path from search_fts where search_fts match ?', ['hello'])).toEqual([
    { path: 'notes/a.md' },
  ])
})

it('stores a vector and finds it with a nearest-neighbour query', () => {
  index = createWasmIndexBackend()
  const generation = index.invoke('index_open', {})
  index.invoke('index_apply', { note: NOTE, generation })
  const vector = Array.from({ length: 384 }, (_, at) => (at === 0 ? 1 : 0))
  const chunk = {
    heading: null,
    posFrom: 0,
    posTo: 5,
    text: 'hello',
    contentHash: 'chunk',
    modelId: 'model',
    vector,
  }
  index.invoke('embed_apply', { path: NOTE.path, chunks: [chunk], generation })

  expect(
    query(
      `select c.note_path as path, v.distance from embedding_vectors v
       join embedding_chunks c on c.id = v.rowid
       where v.embedding match ? and k = 1`,
      [JSON.stringify(vector)],
    ),
  ).toEqual([{ path: 'notes/a.md', distance: 0 }])
})

it('lists the files that the index has no row for', () => {
  const file = { path: 'notes/new.md', modifiedMs: 5, size: 1 }
  index = createWasmIndexBackend({ list: () => [file], move: () => {} })
  const generation = index.invoke('index_open', {})

  expect(index.invoke('index_reconcile_scan', { generation })).toMatchObject({
    total: 1,
    candidates: [{ path: 'notes/new.md' }],
  })
})

it('throws the kind of the native error', () => {
  index = createWasmIndexBackend()
  index.invoke('index_open', {})

  expect(() => query('delete from notes')).toThrow(WasmIndexError)
  expect(index.has('db_query')).toBe(true)
  expect(index.has('note_read')).toBe(false)
})
