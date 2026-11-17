import type { IndexedNote } from '../indexing/indexed-note.ts'

/**
 * A projected note for `index_apply`: a plain note at `notes/sample.md` with
 * one line of text and no links, tags, aliases, claims, emails, assets or
 * tasks. `overrides` replaces fields.
 */
export function createTestIndexedNote(overrides?: Partial<IndexedNote>): IndexedNote {
  return {
    path: 'notes/sample.md',
    id: null,
    title: 'Sample',
    titleKey: 'sample',
    pathKey: 'notes/sample.md',
    kind: 'note',
    dailyDate: null,
    isPrivate: false,
    isPinned: false,
    pinnedOrder: null,
    hasContent: true,
    gistUrl: null,
    gistStale: false,
    fileHash: 'hash',
    mtime: 1,
    text: 'body',
    assetText: '',
    preview: 'body',
    links: [],
    tags: [],
    aliases: [],
    claims: [],
    emails: [],
    assets: [],
    tasks: [],
    ...overrides,
  }
}
