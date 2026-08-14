import {
  getIndexMeta,
  newNoteId,
  notePath,
  setIndexMeta,
  slugForTitle,
  upsertFrontmatter,
  writeNote,
} from '@reflect/core'

/**
 * The App Review demo seed: entering the demo key in the add-provider flow
 * plants a small linked graph, so the reviewer lands on pre-populated
 * content (wiki links, backlinks, tags, tasks) instead of an empty graph.
 * Guarded by an `index_meta` marker so the seed runs at most once per
 * graph, mirroring `welcome-note.ts`.
 */

export const DEMO_NOTES_SEEDED_META_KEY = 'demoNotesSeeded'

interface DemoNote {
  readonly title: string
  readonly body: string
}

const DEMO_NOTES: DemoNote[] = [
  {
    title: 'Meet Reflect (Demo)',
    body: `# Meet Reflect (Demo)

These demo notes were created locally when the App Review demo key was added. Delete them any time.

- Notes connect with [[Wiki Links]] instead of folders: see [[Project Apollo (Demo)]] and [[Reading List (Demo)]].
- Search finds anything in the graph instantly.
- With an AI provider configured, Chat answers questions from these notes. Notes marked private never leave the device.
`,
  },
  {
    title: 'Project Apollo (Demo)',
    body: `# Project Apollo (Demo)

Planning notes for the Apollo launch event. Background reading lives in [[Reading List (Demo)]]. #demo

- [ ] Book the venue for the launch party
- [x] Draft the announcement post
- [ ] Send invites to the beta group

The announcement should point new users at [[Meet Reflect (Demo)]].
`,
  },
  {
    title: 'Reading List (Demo)',
    body: `# Reading List (Demo)

Books worth revisiting this quarter. #demo

- *The Creative Act*: notes on taste, pairs well with the [[Project Apollo (Demo)]] brainstorms.
- *How to Take Smart Notes*: the reason [[Meet Reflect (Demo)]] says to link as you think.
`,
  },
]

export interface SeedDemoNotesOptions {
  /** File-write generation (`graph.generation`), pins the writes. */
  fileGeneration: number
  /** Index-session generation (`index_open`), pins the meta marker. */
  indexGeneration: number
}

/** Plant the demo notes once per graph. Returns whether a seed happened. */
export async function seedDemoNotes(options: SeedDemoNotesOptions): Promise<boolean> {
  if ((await getIndexMeta(DEMO_NOTES_SEEDED_META_KEY)) !== null) {
    return false
  }
  for (const note of DEMO_NOTES) {
    const source = upsertFrontmatter(note.body, { id: newNoteId() })
    await writeNote(notePath(slugForTitle(note.title)), source, options.fileGeneration)
  }
  await setIndexMeta(DEMO_NOTES_SEEDED_META_KEY, 'true', options.indexGeneration)
  return true
}
