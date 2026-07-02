import {
  getIndexMeta,
  listFiles,
  newNoteId,
  notePath,
  setIndexMeta,
  slugForTitle,
  upsertFrontmatter,
  writeNote,
} from '@reflect/core'

/**
 * The first-run seed (Plan 15 step 1): a brand-new graph gets one short,
 * pinned "How to use Reflect" note. It doubles as the optional-setup surface —
 * backup and AI keys are pointers into Settings, not a wizard — so onboarding
 * never gates the editor and "skipping" is just not reading the note.
 */

const WELCOME_TITLE = 'How to use Reflect'

/** Title-derived slug path, same birth rules as any titled note. */
export const WELCOME_NOTE_PATH = notePath(slugForTitle(WELCOME_TITLE))

/**
 * The `index_meta` key marking that onboarding was considered for this graph.
 * `index_clear` deliberately preserves `index_meta`, so the marker survives
 * index rebuilds; only deleting `.reflect/` wholesale resets it.
 */
export const WELCOME_SEEDED_META_KEY = 'welcomeSeeded'

const WELCOME_BODY = `# ${WELCOME_TITLE}

Reflect is a daily notebook: press ⌘D any time to land on today's note and write.

- **Link as you think.** Type \`[[\` and a title — [[Wiki Links]] connect notes. There are no folders.
- **Find anything.** ⌘K searches your whole graph; ⌘/ lists every shortcut.
- **Your files.** Every note is a markdown file in this folder, portable forever.

When you want more, open Settings (⌘,):

- **Backup** — free, private backup of your graph to GitHub.
- **AI providers** — add your own API key to chat with your notes (⌘J). Notes marked private never leave this device.

This note is pinned to the sidebar — unpin it (⌘O) when you're done.
`

export interface EnsureWelcomeNoteOptions {
  /** File-write generation (`graph.generation`) — pins the listing and write. */
  fileGeneration: number
  /** Index-session generation (`index_open`) — pins the meta marker. */
  indexGeneration: number
}

/**
 * Consider onboarding for this graph **exactly once** (find-or-create): when
 * the `welcomeSeeded` marker is absent, an **empty** graph (no markdown under
 * `daily/` or `notes/`) gets the welcome note, a graph with any note at all is
 * someone's existing data and only gets marked. Either way the marker lands,
 * so deleting the note — or emptying the graph entirely — never re-onboards.
 * The marker is stamped after the write: a failed seed retries on the next
 * open, and a retry that finds the note already on disk converges to marking.
 * Returns whether a seed happened.
 */
export async function ensureWelcomeNote(options: EnsureWelcomeNoteOptions): Promise<boolean> {
  if ((await getIndexMeta(WELCOME_SEEDED_META_KEY)) !== null) {
    return false
  }
  const files = await listFiles(options.fileGeneration)
  const seeded = files.length === 0
  if (seeded) {
    const source = upsertFrontmatter(WELCOME_BODY, { id: newNoteId(), pinned: true })
    await writeNote(WELCOME_NOTE_PATH, source, options.fileGeneration)
  }
  await setIndexMeta(WELCOME_SEEDED_META_KEY, 'true', options.indexGeneration)
  return seeded
}
