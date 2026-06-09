/**
 * `@reflect/core` indexing layer (Plan 04) — the TS pipeline that turns parsed
 * notes into the SQLite projection, plus the typed read getters over it.
 */
export {
  openIndex,
  applyIndexedNote,
  removeFromIndex,
  clearIndex,
  watchStart,
  watchStop,
} from './commands'
export { subscribeIndexChanges, applyIndexChanges, type FileChange } from './watch'
export { hashContent } from './hash'
export {
  buildIndexedNote,
  type IndexedNote,
  type IndexedLink,
  type IndexedAlias,
} from './indexed-note'
export { indexNote, rebuildIndex, reconcileIndex, type IndexPassOptions } from './indexer'
export {
  getBacklinks,
  getNote,
  getNotesByTag,
  searchNotes,
  getIndexedHashes,
  resolveWikiTarget,
  type Backlink,
  type NoteRow,
  type SearchHit,
} from './queries'
