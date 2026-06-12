import {
  detectConflictMarkers,
  getConflictedNotes,
  listNotes,
  parseNote,
  readNote,
  slugPathForTitle,
  upsertFrontmatter,
  writeNote,
} from '@reflect/core'
import { moveNoteCarryingSession } from '@/editor/move-note'
import { openSession } from '@/editor/open-documents'
import { newNoteId } from './create-note'

/**
 * The one-time ULID→slug migration (Plan 17c): existing `notes/<ulid>.md`
 * files adopt their title's slug name and gain the frontmatter `id:` ULID
 * that new notes are born with. Idempotent and resumable — each file is
 * independently done-or-not, so an interrupted run just leaves fewer
 * candidates for the next one.
 */

/** A lowercase-ULID basename under `notes/` — the pre-Plan-17 filename shape. */
const ULID_NOTE_RE = /^notes\/[0-9a-hjkmnp-tv-z]{26}\.md$/

/** A note file the migration would rename. */
export interface MigrationCandidate {
  path: string
  title: string
}

/**
 * Every indexed ULID-named note the migration would actually rename, so the
 * prompt's count is a promise, not an estimate. Excluded up front (not
 * silently skipped mid-run): untitled notes (their index title falls back to
 * the ULID stem — nothing readable to rename to; they convert later via the
 * birth path), notes awaiting sync-conflict review (their content — and so
 * their title — is contested), and notes open in a pane right now (their
 * session owns the buffer; the next graph open offers them again).
 */
export async function findMigrationCandidates(): Promise<MigrationCandidate[]> {
  const [entries, conflicted] = await Promise.all([listNotes({ tag: null }), getConflictedNotes()])
  const contested = new Set(conflicted.map((note) => note.path))
  return entries
    .filter((entry) => ULID_NOTE_RE.test(entry.path))
    .filter((entry) => !entry.path.endsWith(`/${entry.title}.md`))
    .filter((entry) => !contested.has(entry.path))
    .filter((entry) => openSession(entry.path) === null)
    .map((entry) => ({ path: entry.path, title: entry.title }))
}

export interface MigrationResult {
  moved: number
  /** Candidates skipped this run (open in a pane, conflicted, or untitled now). */
  skipped: number
  /** Candidates that errored, with the messages (the run continues past them). */
  failed: Array<{ path: string; message: string }>
}

export interface MigrateOptions {
  candidates: MigrationCandidate[]
  /** The graph write generation (`GraphInfo.generation`). */
  generation: number
  onProgress?: (done: number, total: number) => void
}

/**
 * Run the migration over `candidates`: per file — stamp `id:` frontmatter if
 * missing (preserving the header bytes exactly), derive the slug target from
 * the *current* content's title, and move file + projection in one Rust
 * transaction. Conservative skips, never failures: a note open in a pane
 * (its session owns the buffer), one carrying conflict markers (its content
 * is contested), or one whose title vanished since indexing.
 */
export async function migrateUlidNotes(options: MigrateOptions): Promise<MigrationResult> {
  const { candidates, generation, onProgress } = options
  const result: MigrationResult = { moved: 0, skipped: 0, failed: [] }
  let done = 0
  for (const candidate of candidates) {
    try {
      if (openSession(candidate.path) !== null) {
        // A live session owns this buffer; stamping `id:` under it would race
        // the editor. Rare (the prompt fires on graph open) — next run's job.
        result.skipped += 1
        continue
      }
      let content = await readNote(candidate.path)
      if (detectConflictMarkers(content)) {
        result.skipped += 1
        continue
      }
      const parsed = parseNote({ path: candidate.path, source: content })
      const titled =
        parsed.headings.some((heading) => heading.level === 1 && heading.text !== '') ||
        typeof (parsed.frontmatter as Record<string, unknown>).title === 'string'
      if (!titled) {
        result.skipped += 1
        continue
      }
      if (parsed.frontmatter.id === undefined) {
        content = upsertFrontmatter(content, { id: newNoteId() })
        await writeNote(candidate.path, content, generation)
      }
      const target = await slugPathForTitle(candidate.path, parsed.title)
      if (target !== candidate.path) {
        await moveNoteCarryingSession(candidate.path, target, generation)
      }
      result.moved += 1
    } catch (cause) {
      result.failed.push({
        path: candidate.path,
        message: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      done += 1
      onProgress?.(done, candidates.length)
    }
  }
  return result
}
