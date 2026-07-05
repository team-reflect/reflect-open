import { describe, expect, it } from 'vitest'
import type { IndexedNote } from '@reflect/core'
import { createDevIndexDb, type DevIndexDb } from '@/dev/dev-index-db'

function sampleNote(overrides: Partial<IndexedNote> = {}): IndexedNote {
  return {
    path: 'notes/sample.md',
    id: '01hv3xq7c2dm8k4t9w5e6r1n99',
    title: 'Sample Note',
    titleKey: 'sample note',
    kind: 'note',
    dailyDate: null,
    isPrivate: false,
    isPinned: false,
    pinnedOrder: null,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
    fileHash: 'hash-1',
    mtime: 1_700_000_000_000,
    text: 'Sample Note body about local-first sync',
    assetText: '',
    preview: 'body about local-first sync',
    links: [
      {
        kind: 'wiki',
        targetRaw: 'Other Note',
        targetKey: 'other note',
        alias: null,
        posFrom: 3,
        posTo: 16,
      },
    ],
    tags: [{ tag: 'book', tagKey: 'book' }],
    aliases: [],
    emails: [{ email: 'Sample@Example.com', emailKey: 'sample@example.com' }],
    assets: [],
    tasks: [{ markerOffset: 40, text: 'Do the thing', raw: '- [ ] Do the thing', checked: false, dueDate: null }],
    ...overrides,
  }
}

async function openDb(): Promise<DevIndexDb> {
  return createDevIndexDb()
}

describe('createDevIndexDb', () => {
  it('applies the real migrations and answers db_query-style reads', async () => {
    const db = await openDb()
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notes', 'tags', 'tasks', 'search_fts') ORDER BY name",
      [],
    )
    expect(tables.map((row) => row['name'])).toEqual(['notes', 'search_fts', 'tags', 'tasks'])
  })

  it('applies a note projection across notes, tags, tasks, and FTS', async () => {
    const db = await openDb()
    db.applyNote(sampleNote())

    const notes = db.query('SELECT path, title, is_pinned FROM notes', [])
    expect(notes).toEqual([{ path: 'notes/sample.md', title: 'Sample Note', is_pinned: 0 }])

    const tags = db.query('SELECT tag FROM tags WHERE note_path = ?', ['notes/sample.md'])
    expect(tags).toEqual([{ tag: 'book' }])

    const tasks = db.query('SELECT text, checked FROM tasks', [])
    expect(tasks).toEqual([{ text: 'Do the thing', checked: 0 }])

    const emails = db.query('SELECT email, email_key FROM note_emails', [])
    expect(emails).toEqual([
      { email: 'Sample@Example.com', email_key: 'sample@example.com' },
    ])

    const hits = db.query("SELECT path FROM search_fts WHERE search_fts MATCH 'sync'", [])
    expect(hits).toEqual([{ path: 'notes/sample.md' }])
  })

  it('re-applying a note replaces its rows instead of duplicating them', async () => {
    const db = await openDb()
    db.applyNote(sampleNote())
    db.applyNote(sampleNote({ title: 'Renamed Title', titleKey: 'renamed title' }))

    const notes = db.query('SELECT title FROM notes', [])
    expect(notes).toEqual([{ title: 'Renamed Title' }])
    const fts = db.query('SELECT count(*) AS hits FROM search_fts', [])
    expect(fts).toEqual([{ hits: 1 }])
  })

  it('moves every row to the new path and refuses an occupied destination', async () => {
    const db = await openDb()
    db.applyNote(sampleNote())
    db.moveNote('notes/sample.md', 'notes/renamed.md')

    expect(db.query('SELECT path FROM notes', [])).toEqual([{ path: 'notes/renamed.md' }])
    expect(db.query('SELECT note_path FROM tags', [])).toEqual([
      { note_path: 'notes/renamed.md' },
    ])
    expect(db.query('SELECT note_path FROM note_emails', [])).toEqual([
      { note_path: 'notes/renamed.md' },
    ])

    db.applyNote(sampleNote({ path: 'notes/sample.md', id: '01hv3xq7c2dm8k4t9w5e6r1n98' }))
    expect(() => db.moveNote('notes/sample.md', 'notes/renamed.md')).toThrowError(
      /already indexed/,
    )
    // The refused move must leave both notes' rows untouched.
    const paths = db.query('SELECT path FROM notes ORDER BY path', [])
    expect(paths).toEqual([{ path: 'notes/renamed.md' }, { path: 'notes/sample.md' }])
  })

  it('removes a note and its FTS row', async () => {
    const db = await openDb()
    db.applyNote(sampleNote())
    db.removeNote('notes/sample.md')

    expect(db.query('SELECT count(*) AS rows FROM notes', [])).toEqual([{ rows: 0 }])
    expect(db.query('SELECT count(*) AS rows FROM tags', [])).toEqual([{ rows: 0 }])
    expect(db.query('SELECT count(*) AS rows FROM search_fts', [])).toEqual([{ rows: 0 }])
  })

  it('binds boolean parameters as integers (the json_to_sql contract)', async () => {
    const db = await openDb()
    db.applyNote(sampleNote({ isPinned: true, pinnedOrder: 1 }))
    const pinned = db.query('SELECT path FROM notes WHERE is_pinned = ?', [true])
    expect(pinned).toEqual([{ path: 'notes/sample.md' }])
  })

  it('chat writes mirror chat_write.rs: seq assignment, upsert-by-id, cascade delete', async () => {
    const db = await openDb()
    const conversation = { id: 'c1', title: 'first question', createdMs: 1, updatedMs: 1 }
    const message = (id: string, userText: string) => ({
      id,
      conversationId: 'c1',
      userText,
      attachments: '[]',
      parts: '[]',
      responseMessages: '[]',
      createdMs: 1,
    })

    db.saveChatMessage(conversation, message('m1', 'one'))
    db.saveChatMessage({ ...conversation, title: 'renamed?', updatedMs: 9 }, message('m2', 'two'))
    // A settle-time re-save: conflicts on id, keeps its seq, updates the body.
    db.saveChatMessage(conversation, { ...message('m1', 'one settled'), parts: '[{"k":1}]' })

    // Title is set once (save 2's rename lost); updated_ms is last-write-wins,
    // so the settle re-save's stamp is the one that sticks.
    expect(
      db.query('SELECT title, updated_ms FROM chat_conversations WHERE id = ?', ['c1']),
    ).toEqual([{ title: 'first question', updated_ms: 1 }])
    expect(
      db.query('SELECT id, seq, user_text FROM chat_messages ORDER BY seq', []),
    ).toEqual([
      { id: 'm1', seq: 0, user_text: 'one settled' },
      { id: 'm2', seq: 1, user_text: 'two' },
    ])

    db.deleteChatConversation('c1')
    expect(db.query('SELECT count(*) AS rows FROM chat_messages', [])).toEqual([{ rows: 0 }])
  })

  it('clearing the index leaves chat history alone (the durable-tables rule)', async () => {
    const db = await openDb()
    db.applyNote(sampleNote())
    db.saveChatMessage({ id: 'c1', title: 't', createdMs: 1, updatedMs: 1 }, {
      id: 'm1',
      conversationId: 'c1',
      userText: 'hello',
      attachments: '[]',
      parts: '[]',
      responseMessages: '[]',
      createdMs: 1,
    })

    db.clear()

    expect(db.query('SELECT count(*) AS rows FROM notes', [])).toEqual([{ rows: 0 }])
    expect(db.query('SELECT count(*) AS rows FROM chat_messages', [])).toEqual([{ rows: 1 }])
  })
})
