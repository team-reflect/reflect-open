// Generate packages/db/src/schema.gen.ts from the Rust migrations.
//
// The index runs in Rust and its schema lives in rusqlite_migration `.sql` files,
// so there's no long-running server to introspect (as a typical kysely-codegen
// setup would). Instead we replay the migrations into a throwaway SQLite DB
// (better-sqlite3, which ships FTS5) and point kysely-codegen at it. The result
// is committed; CI re-runs this and fails on any diff, so the TS types can never
// drift from the migrations. `--camel-case` matches the runtime CamelCasePlugin.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const migrationsDir = join(here, '..', '..', '..', 'crates', 'index-schema', 'migrations')
const outFile = join(packageRoot, 'src', 'schema.gen.ts')

const tmp = mkdtempSync(join(tmpdir(), 'reflect-codegen-'))
const dbPath = join(tmp, 'index.sqlite')

try {
  const db = new Database(dbPath)
  try {
    // The 0002 migration creates a vec0 virtual table; the throwaway DB needs
    // the sqlite-vec extension loaded just like the Rust runtime registers it.
    sqliteVec.load(db)
    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
    if (files.length === 0) {
      throw new Error(`no .sql migrations found in ${migrationsDir}`)
    }
    for (const file of files) {
      db.exec(readFileSync(join(migrationsDir, file), 'utf8'))
    }
    // kysely-codegen introspects over its own connection, which has no
    // sqlite-vec loaded — drop the vec0 table (vector reads go through raw
    // SQL at runtime; it was never going to appear in the typed schema).
    db.exec('DROP TABLE IF EXISTS embedding_vectors')
  } finally {
    db.close() // always close, even if a migration exec throws
  }

  // Resolve the kysely-codegen bin so we don't depend on PATH.
  const pkgPath = require.resolve('kysely-codegen/package.json')
  const bin = require('kysely-codegen/package.json').bin
  const binRel = typeof bin === 'string' ? bin : bin['kysely-codegen']
  const binPath = join(dirname(pkgPath), binRel)

  execFileSync(
    process.execPath,
    [
      binPath,
      '--dialect',
      'better-sqlite3',
      '--url',
      dbPath,
      '--camel-case',
      // Hide FTS5's internal shadow tables (search_fts_config/content/data/...).
      '--exclude-pattern',
      'search_fts_*',
      '--out-file',
      outFile,
    ],
    { stdio: 'inherit', cwd: packageRoot },
  )
  console.log(`Wrote ${outFile}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
