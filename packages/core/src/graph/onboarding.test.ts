import { describe, expect, it } from 'vitest'
import { overrideNoteFileService } from '../testing/graph.ts'
import { parseNote } from '../markdown/extract.ts'
import { isPinned } from '../markdown/model.ts'
import {
  createTestIdService,
  createTestIndexStoreService,
  createTestNoteFileService,
} from '../testing/index.ts'
import type { VaultScanStats } from './note-file-service.ts'
import { ensureWelcomeNote, WELCOME_NOTE_PATH, WELCOME_SEEDED_META_KEY } from './onboarding.ts'

const GENERATIONS = { fileGeneration: 1, indexGeneration: 7 }

function setup(options?: {
  files?: Record<string, string>
  meta?: Record<string, string>
  stats?: Partial<VaultScanStats>
}) {
  const indexStore = createTestIndexStoreService({ meta: options?.meta ?? {} })
  const files = createTestNoteFileService({ files: options?.files ?? {} })
  const stats = options?.stats
  const noteFile =
    stats === undefined
      ? files
      : overrideNoteFileService(files, {
          vaultScanStats: () => {
            return Promise.resolve({
              notes: stats.notes ?? 0,
              attachments: stats.attachments ?? 0,
              skipped: stats.skipped ?? 0,
            })
          },
        })
  const id = createTestIdService()
  return { indexStore, files, ctx: { indexStore, noteFile, id }, id }
}

describe('ensureWelcomeNote', () => {
  it('seeds a pinned, id-carrying how-to note into an empty unmarked graph and marks it', async () => {
    const { ctx, files, indexStore, id } = setup()
    expect(await ensureWelcomeNote(ctx, GENERATIONS)).toBe(true)

    const writes = files.writes()
    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toBe(WELCOME_NOTE_PATH)
    expect(writes[0]!.generation).toBe(1)
    expect(WELCOME_NOTE_PATH).toBe('notes/how-to-use-reflect.md')

    const { frontmatter, title } = parseNote({
      path: writes[0]!.path,
      source: writes[0]!.contents,
    })
    expect(title).toBe('How to use Reflect')
    expect(isPinned(frontmatter)).toBe(true)
    expect(id.issued()).toHaveLength(1)
    expect(frontmatter.id).toBe(id.issued()[0])
    expect(writes[0]!.contents).toContain('[[Wiki Links]]')

    expect(await indexStore.getMeta(WELCOME_SEEDED_META_KEY)).toBe('true')
    expect(indexStore.calls().filter((call) => call.method === 'setMeta')).toEqual([
      {
        method: 'setMeta',
        key: WELCOME_SEEDED_META_KEY,
        value: 'true',
        generation: 7,
      },
    ])
  })

  it('marks a graph that already has notes without writing into it', async () => {
    const { ctx, files, indexStore } = setup({ files: { 'notes/existing.md': '# Existing\n' } })
    expect(await ensureWelcomeNote(ctx, GENERATIONS)).toBe(false)
    expect(files.writes()).toHaveLength(0)
    expect(await indexStore.getMeta(WELCOME_SEEDED_META_KEY)).toBe('true')
  })

  it.each([
    { label: 'only attachments (a folder of PDFs)', stats: { attachments: 3 } },
    { label: 'only skipped entries (unreadable content)', stats: { skipped: 1 } },
  ])('marks a vault with $label without writing into it', async ({ stats }) => {
    const { ctx, files, indexStore } = setup({ stats })
    expect(await ensureWelcomeNote(ctx, GENERATIONS)).toBe(false)
    expect(files.writes()).toHaveLength(0)
    expect(await indexStore.getMeta(WELCOME_SEEDED_META_KEY)).toBe('true')
  })

  it('does nothing once marked, so an emptied graph is not re-onboarded', async () => {
    const { ctx, files, id } = setup({ meta: { [WELCOME_SEEDED_META_KEY]: 'true' } })
    expect(await ensureWelcomeNote(ctx, GENERATIONS)).toBe(false)
    expect(files.writes()).toHaveLength(0)
    expect(id.issued()).toHaveLength(0)
  })
})
