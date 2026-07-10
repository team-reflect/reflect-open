import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { load as loadSqliteVec } from 'sqlite-vec'
import { describe, expect, it } from 'vitest'
import { parseNote } from '../markdown'
import { setBridge } from '../ipc/bridge'
import { buildIndexedNote, type IndexedNote } from './indexed-note'
import { getBacklinks, resolveWikiTarget, suggestWikiTargets } from './queries'
import { wikiSuggestionInsertText } from './suggest'

type SqliteParameter = string | number | bigint | Buffer | null
type SqliteRow = Record<string, unknown>

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../../../crates/index-schema/migrations/', import.meta.url),
)

function openMigratedIndex(): Database.Database {
  const database = new Database(':memory:')
  try {
    loadSqliteVec(database)
    const migrations = readdirSync(MIGRATIONS_DIRECTORY)
      .filter((filename) => filename.endsWith('.sql'))
      .sort()
    for (const migration of migrations) {
      database.exec(readFileSync(`${MIGRATIONS_DIRECTORY}/${migration}`, 'utf8'))
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function sqliteParameter(value: unknown): SqliteParameter {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    Buffer.isBuffer(value)
  ) {
    return value
  }
  throw new TypeError(`unsupported SQLite parameter: ${typeof value}`)
}

function queryRows(
  database: Database.Database,
  sql: string,
  params: readonly unknown[],
): Promise<SqliteRow[]> {
  const statement = database.prepare<SqliteParameter[], SqliteRow>(sql)
  return Promise.resolve(statement.all(...params.map(sqliteParameter)))
}

function applyProjection(database: Database.Database, indexed: IndexedNote): void {
  database
    .prepare<
      [
        string,
        string | null,
        string,
        string,
        string,
        string | null,
        number,
        number,
        number | null,
        number,
        string,
        string,
        number,
        string | null,
        number,
      ]
    >(
      `INSERT INTO notes(
        path, id, title, title_key, kind, daily_date, is_private, is_pinned,
        pinned_order, mtime, file_hash, preview, has_conflict, gist_url, gist_stale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      indexed.path,
      indexed.id,
      indexed.title,
      indexed.titleKey,
      indexed.kind,
      indexed.dailyDate,
      Number(indexed.isPrivate),
      Number(indexed.isPinned),
      indexed.pinnedOrder,
      indexed.mtime,
      indexed.fileHash,
      indexed.preview,
      Number(indexed.hasConflict),
      indexed.gistUrl,
      Number(indexed.gistStale),
    )

  const insertAlias = database.prepare<[string, string, string]>(
    'INSERT INTO aliases(note_path, alias, alias_key) VALUES (?, ?, ?)',
  )
  for (const alias of indexed.aliases) {
    insertAlias.run(indexed.path, alias.alias, alias.aliasKey)
  }

  const insertLink = database.prepare<
    [string, string, string, string, string | null, number, number]
  >(
    `INSERT INTO links(
      source_path, kind, target_raw, target_key, alias, pos_from, pos_to
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const link of indexed.links) {
    insertLink.run(
      indexed.path,
      link.kind,
      link.targetRaw,
      link.targetKey,
      link.alias,
      link.posFrom,
      link.posTo,
    )
  }
}

function project(path: string, source: string, mtime: number): IndexedNote {
  return buildIndexedNote(parseNote({ path, source }), {
    fileHash: `hash-${path}`,
    mtime,
    source,
  })
}

describe('v1 subject alias flow', () => {
  it('projects, resolves, backlinks, and autocompletes Dad through the real schema', async () => {
    const database = openMigratedIndex()
    const person = project('notes/tim-maccaw-dad.md', '# Tim MacCaw // Dad\n', 20)
    const source = project('notes/family.md', '# Family\n\nCall [[Dad]].\n', 10)

    expect(person.aliases).toEqual([
      { alias: 'Tim MacCaw', aliasKey: 'tim maccaw' },
      { alias: 'Dad', aliasKey: 'dad' },
    ])
    applyProjection(database, person)
    applyProjection(database, source)

    setBridge({
      invoke: (command, args) => {
        if (command !== 'db_query') {
          return Promise.reject(new Error(`unexpected command: ${command}`))
        }
        const sql = args['sql']
        const params = args['params']
        if (typeof sql !== 'string' || !Array.isArray(params)) {
          return Promise.reject(new TypeError('invalid db_query arguments'))
        }
        return queryRows(database, sql, params)
      },
      listen: () => Promise.resolve(() => {}),
    })

    try {
      await expect(resolveWikiTarget('Dad')).resolves.toEqual({
        kind: 'resolved',
        ref: 'notes/tim-maccaw-dad.md',
      })
      await expect(getBacklinks('notes/tim-maccaw-dad.md')).resolves.toMatchObject([
        { sourcePath: 'notes/family.md', targetRaw: 'Dad' },
      ])

      const suggestions = await suggestWikiTargets('Dad')
      expect(suggestions[0]).toMatchObject({
        target: 'Tim MacCaw // Dad',
        path: 'notes/tim-maccaw-dad.md',
        title: 'Tim MacCaw // Dad',
        alias: 'Dad',
      })
      const inserted = wikiSuggestionInsertText(suggestions[0]!)
      expect(inserted).toBe('Tim MacCaw // Dad|Dad')
      expect(parseNote({ path: 'notes/selected.md', source: `[[${inserted}]]` }).wikiLinks).toEqual([
        expect.objectContaining({ target: 'Tim MacCaw // Dad', alias: 'Dad' }),
      ])

      // A standalone title is a stronger claimant than the subject alias. The
      // link, backlink, and autocomplete ranking must all move together.
      const standaloneDad = project('notes/dad.md', '# Dad\n', 30)
      applyProjection(database, standaloneDad)
      await expect(resolveWikiTarget('Dad')).resolves.toEqual({
        kind: 'resolved',
        ref: 'notes/dad.md',
      })
      await expect(getBacklinks('notes/tim-maccaw-dad.md')).resolves.toEqual([])
      await expect(getBacklinks('notes/dad.md')).resolves.toMatchObject([
        { sourcePath: 'notes/family.md', targetRaw: 'Dad' },
      ])

      const selected = project(
        'notes/selected.md',
        `# Selected\n\nCall [[${inserted}]].\n`,
        40,
      )
      applyProjection(database, selected)
      expect(selected.links).toEqual([
        expect.objectContaining({
          targetRaw: 'Tim MacCaw // Dad',
          targetKey: 'tim maccaw // dad',
          alias: 'Dad',
        }),
      ])
      await expect(resolveWikiTarget(selected.links[0]!.targetRaw)).resolves.toEqual({
        kind: 'resolved',
        ref: 'notes/tim-maccaw-dad.md',
      })
      await expect(getBacklinks('notes/tim-maccaw-dad.md')).resolves.toMatchObject([
        {
          sourcePath: 'notes/selected.md',
          targetRaw: 'Tim MacCaw // Dad',
          alias: 'Dad',
        },
      ])
      await expect(getBacklinks('notes/dad.md')).resolves.toMatchObject([
        { sourcePath: 'notes/family.md', targetRaw: 'Dad' },
      ])

      const collidedSuggestions = await suggestWikiTargets('Dad')
      expect(collidedSuggestions.map((suggestion) => suggestion.path)).toEqual([
        'notes/dad.md',
        'notes/tim-maccaw-dad.md',
      ])
      expect(wikiSuggestionInsertText(collidedSuggestions[0]!)).toBe('Dad')
      expect(wikiSuggestionInsertText(collidedSuggestions[1]!)).toBe(
        'Tim MacCaw // Dad|Dad',
      )
    } finally {
      setBridge(null)
      database.close()
    }
  })
})
