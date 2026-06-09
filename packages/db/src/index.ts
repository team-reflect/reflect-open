/**
 * `@reflect/db` — Kysely schema, generated types, and the IPC query-builder
 * dialect for the local SQLite projection.
 *
 * Fully wired in Plan 04 (local index). For now this package only declares the
 * database shape so dependents can compile against a stable type; the table
 * interfaces are added alongside the indexer.
 */

/** The local SQLite projection. Tables are introduced in Plan 04. */
export interface Database {
  // Populated in Plan 04: notes, note_text, links, backlinks, tags, aliases, …
  [table: string]: never
}
