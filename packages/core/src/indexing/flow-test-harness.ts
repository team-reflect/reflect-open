import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { getLoadablePath as getSqliteVecPath } from 'sqlite-vec'
import { expect } from 'vitest'
import { resolveOrCreateNoteWithTitle } from '../graph/create-note'
import { resolveExistingWikiTarget } from '../graph/resolve-existing-wiki-target'
import { normalizeWikiTarget, parseNote } from '../markdown'
import { setBridge } from '../ipc/bridge'
import { buildIndexedNote, type IndexedNote } from './indexed-note'
import type { suggestWikiLinkTargets } from './queries'

/**
 * Shared harness for projection-flow tests (`*-flow.test.ts`): a real
 * in-memory SQLite index built from the production migration chain, a bridge
 * that routes `db_query` into it (disk probes see an empty graph), and the
 * end-to-end "selecting this suggestion opens its path" assertion.
 */

type SqliteRow = Record<string, unknown>

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../../../crates/index-schema/migrations/', import.meta.url),
)

export function openMigratedIndex(): DatabaseSync {
  const database = new DatabaseSync(':memory:', { allowExtension: true })
  try {
    // Keep this an exact production migration chain: 0002/0003 create vec0
    // tables, so their native extension must be available before replay.
    database.loadExtension(getSqliteVecPath())
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

function sqliteParameter(value: unknown): SQLInputValue {
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
  database: DatabaseSync,
  sql: string,
  params: readonly unknown[],
): Promise<SqliteRow[]> {
  const statement = database.prepare(sql)
  return Promise.resolve(statement.all(...params.map(sqliteParameter)))
}

export function applyProjection(database: DatabaseSync, indexed: IndexedNote): void {
  database
    .prepare(
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

  const insertAlias = database.prepare(
    'INSERT INTO aliases(note_path, alias, alias_key) VALUES (?, ?, ?)',
  )
  for (const alias of indexed.aliases) {
    insertAlias.run(indexed.path, alias.alias, alias.aliasKey)
  }

  const insertLink = database.prepare(
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

export function project(path: string, source: string, mtime: number): IndexedNote {
  return buildIndexedNote(parseNote({ path, source }), {
    fileHash: `hash-${path}`,
    mtime,
    source,
  })
}

export function connectIndex(database: DatabaseSync): void {
  setBridge({
    invoke: (command, args) => {
      // The projections exist only in the index. Disk probes see an empty
      // graph, so the writable resolvers exercise their indexed tiers.
      if (command === 'list_files') {
        return Promise.resolve([])
      }
      if (command === 'note_read') {
        return Promise.reject({ kind: 'notFound', message: 'not on disk' })
      }
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
}

export async function expectSuggestionOpensItsPath(
  suggestion: Awaited<
    ReturnType<typeof suggestWikiLinkTargets>
  >['suggestions'][number],
): Promise<void> {
  expect(suggestion.path).not.toBeNull()
  const parsed = parseNote({
    path: 'notes/selection-check.md',
    source: `[[${suggestion.insertText}]]`,
  }).wikiLinks
  expect(parsed).toHaveLength(1)
  const target = parsed[0]!.target
  // Both branches mirror the editor's writable click handler, which routes
  // date-shaped targets through the ambiguity-preserving existing-note
  // resolver and everything else through resolve-or-create.
  const resolution =
    normalizeWikiTarget(target).date !== undefined
      ? resolveExistingWikiTarget(target, 1)
      : resolveOrCreateNoteWithTitle(target, 1)
  await expect(resolution).resolves.toEqual({
    kind: 'resolved',
    path: suggestion.path,
  })
}
