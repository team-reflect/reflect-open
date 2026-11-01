import { sql, type RawBuilder } from 'kysely'
import type { NoteDocumentService } from '../documents/note-document-service.ts'
import { AppError, errorMessage } from '../errors.ts'
import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'
import { hasSearchableChar } from '../lib/searchable-char.ts'
import { wikiNoteReference } from '../graph/note-reference.ts'
import { asciiLowerCase } from '../graph/paths.ts'
import { foldKey } from '../markdown/keys.ts'
import { displayNoteTitle } from '../markdown/note-title.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import { plainTextSpans } from '../markdown/extract.ts'
import { plainTextOfRange } from '../markdown/plain-text.ts'
import { lineEndAt, lineStartAt, prepareBlockContext } from './block-context.ts'
import type { DatabaseService } from './database-service.ts'
import { findNoteMentions, linksToAnyName, type NoteMention } from './note-mentions.ts'
import { keysAddressingPath, sourceRecency } from './queries-shared.ts'
import { containsUnsegmentedScript, quoteFtsLiteral } from './search-query.ts'
import { serializeWikiSuggestionAddress } from './suggest.ts'

/**
 * Names shorter than this are too common to suggest: `AI` or `Go` would
 * flag half the graph. A name in an unsegmented script (Han, kana, …)
 * carries more per character, so two are enough there (`田中`).
 */
const MIN_NAME_LENGTH = 3
const MIN_UNSEGMENTED_NAME_LENGTH = 2

/**
 * How many mentioning notes one lookup returns, newest first.
 */
const MAX_SOURCES = 30

/**
 * How many candidate notes one lookup may read to find them. The full-text
 * match is a superset (a common name also hits code, URLs, links and titles),
 * so reading stops here even when fewer than {@link MAX_SOURCES} turned out
 * to mention the name: a common name must not read the whole graph.
 */
const MAX_READS = 100

/**
 * A note the full-text index offers as possibly mentioning the target.
 */
interface CandidateSource {
  readonly sourcePath: string
  readonly sourceTitle: string
}

/**
 * One line of another note that names the target without linking to it.
 */
export interface SuggestedBacklink {
  readonly sourcePath: string
  readonly sourceTitle: string
  /**
   * The mentioning line as a reader sees it: Markdown syntax dropped.
   */
  readonly line: string
  /**
   * The line's first mention: what {@link SuggestedBacklinkService.linkMention} rewrites.
   */
  readonly mention: NoteMention
}

export interface SuggestedBacklinkServiceDeps {
  readonly database: DatabaseService
  readonly noteDocuments: NoteDocumentService
  readonly progress: ProgressPort
  readonly graphSession: GraphSessionSource
}

/**
 * Notes that name a note in plain text without linking to it, and the
 * one-click rewrite of such a mention into a `[[wiki link]]` — old Reflect's
 * suggested backlinks.
 */
export interface SuggestedBacklinkService {
  /**
   * Lines of other notes that mention `path` by its title or an alias but
   * don't link to it: the newest {@link MAX_SOURCES} such notes, found among
   * at most {@link MAX_READS} candidates. A source that already links to
   * `path` is left out entirely.
   * Daily notes and templates have no mentions, and neither does a name that
   * another note also claims, since linking it could resolve to that note
   * instead. Sources are ordered newest first; the lines of one source are in
   * document order, one entry per line.
   */
  getSuggestedBacklinks(path: string): Promise<SuggestedBacklink[]>
  /**
   * Rewrite `mention` in `sourcePath` as a wiki link to `path`, keeping its
   * spelling. Goes through the open editor session when there is one. When
   * the note has changed so that the mention is no longer at that position,
   * nothing is written; the failure is reported, then rethrown.
   */
  linkMention(path: string, sourcePath: string, mention: NoteMention): Promise<void>
}

/**
 * Whether `[[name]]` reads as a plain name whose key is `key`, exactly as the
 * link parser will read it once written: not a heading (`C# Guide` is note
 * `C`, heading `Guide`), not a path (`a/b`), and safe inside the brackets.
 */
function readsAsPlainName(name: string, key: string): boolean {
  if (serializeWikiSuggestionAddress(name, null) === null) {
    return false
  }
  const reference = wikiNoteReference(name)
  return reference?.kind === 'key' && reference.key === key
}

/**
 * Refusals a link reports to the user: the source changed under the list, or
 * the target lost the name the list showed.
 */
const MENTION_MOVED = 'The note has changed — try again in a moment.'
const NOT_LINKABLE = 'This note can no longer be linked by that name.'

class SuggestedBacklinkServiceImpl implements SuggestedBacklinkService {
  readonly #deps: SuggestedBacklinkServiceDeps

  constructor(deps: SuggestedBacklinkServiceDeps) {
    this.#deps = deps
  }

  async getSuggestedBacklinks(path: string): Promise<SuggestedBacklink[]> {
    const { generation } = requireGraphSession(this.#deps.graphSession)
    const names = await this.#linkableNames(path)
    if (names.length === 0) {
      return []
    }
    const candidates = await this.#candidateSources(path, names)
    // Read in batches of the sources still wanted, so no note is read past the
    // last one returned, and keep going past candidates with no real mention.
    const mentions: SuggestedBacklink[] = []
    let sources = 0
    let next = 0
    while (sources < MAX_SOURCES && next < candidates.length) {
      const batch = candidates.slice(next, next + MAX_SOURCES - sources)
      next += batch.length
      const read = await Promise.all(
        batch.map(async (candidate) => {
          const content = await this.#deps.noteDocuments.readExisting(
            candidate.sourcePath,
            generation,
          )
          return { candidate, content }
        }),
      )
      for (const { candidate, content } of read) {
        const lines = this.#mentionLines(candidate, content, names)
        if (lines.length > 0) {
          mentions.push(...lines)
          sources += 1
        }
      }
    }
    return mentions
  }

  async linkMention(path: string, sourcePath: string, mention: NoteMention): Promise<void> {
    try {
      const { generation } = requireGraphSession(this.#deps.graphSession)
      const names = await this.#linkableNames(path)
      // The target was renamed (or a name became ambiguous) since the list
      // loaded: the source is fine, the spelling no longer opens this note.
      if (!names.some((name) => foldKey(name) === foldKey(mention.text))) {
        throw new AppError('notFound', NOT_LINKABLE)
      }
      await this.#deps.noteDocuments.commitSourceEdit(
        sourcePath,
        (source) => {
          const current = findNoteMentions(prepareBlockContext(source), names).find((found) => {
            return found.from === mention.from && found.text === mention.text
          })
          if (current === undefined) {
            throw new AppError('notFound', MENTION_MOVED)
          }
          return `${source.slice(0, current.from)}[[${current.text}]]${source.slice(current.to)}`
        },
        { generation },
      )
    } catch (cause) {
      this.#deps.progress.fail('Linking mention', errorMessage(cause))
      throw cause
    }
  }

  /**
   * The note's title and aliases that a plain `[[name]]` would resolve back to
   * this note alone. A shared or ambiguous spelling is dropped: linking it
   * could point somewhere else.
   */
  async #linkableNames(path: string): Promise<string[]> {
    const { db } = this.#deps.database
    const note = await db
      .selectFrom('notes')
      .where('path', '=', path)
      .select(['title', 'kind'])
      .executeTakeFirst()
    if (note?.kind !== 'note') {
      return []
    }
    const aliases = await db
      .selectFrom('aliases')
      .where('notePath', '=', path)
      .select('alias')
      .execute()

    const byKey = new Map<string, string>()
    for (const name of [
      displayNoteTitle(note.title),
      note.title,
      ...aliases.map((row) => row.alias),
    ]) {
      const trimmed = name.trim()
      const key = foldKey(trimmed)
      if (
        !byKey.has(key) &&
        [...trimmed].length >=
          (containsUnsegmentedScript(trimmed) ? MIN_UNSEGMENTED_NAME_LENGTH : MIN_NAME_LENGTH) &&
        hasSearchableChar(trimmed) &&
        readsAsPlainName(trimmed, key)
      ) {
        byKey.set(key, trimmed)
      }
    }

    const addressing = await keysAddressingPath(db, [...byKey.keys()], path)
    return [...byKey].filter(([key]) => addressing.has(key)).map(([, name]) => name)
  }

  /**
   * Notes whose body may mention a name and that don't already link to
   * `path`, newest first. A superset of the real mentions: the full-text match
   * ignores case, accents and Markdown structure. A name in an unsegmented
   * script can't use it (the tokenizer indexes an uninterrupted run of Han or
   * kana as one token), so those match by substring instead, with both sides
   * lowercased the way SQLite's `lower` does it: ASCII letters only.
   */
  async #candidateSources(path: string, names: readonly string[]): Promise<CandidateSource[]> {
    const phrases = names.filter((name) => !containsUnsegmentedScript(name))
    const substrings = names.filter((name) => containsUnsegmentedScript(name))
    const admissions: Array<RawBuilder<boolean>> = []
    if (phrases.length > 0) {
      const match = phrases.map((name) => `body : ${quoteFtsLiteral(name)}`).join(' OR ')
      admissions.push(
        sql<boolean>`"notes"."path" in (select path from search_fts where search_fts match ${match})`,
      )
    }
    if (substrings.length > 0) {
      const contains = sql.join(
        substrings.map((name) => {
          return sql`instr(lower(body), ${asciiLowerCase(name)}) > 0`
        }),
        sql` or `,
      )
      admissions.push(
        sql<boolean>`"notes"."path" in (select path from search_fts where ${contains})`,
      )
    }
    return await this.#deps.database.db
      .selectFrom('notes')
      .where(sql<boolean>`(${sql.join(admissions, sql` or `)})`)
      .where('notes.path', '!=', path)
      .where('notes.kind', '!=', 'template')
      .where((eb) => {
        return eb.not(
          eb.exists(
            eb
              .selectFrom('backlinks')
              .select(sql<number>`1`.as('one'))
              .whereRef('backlinks.sourcePath', '=', 'notes.path')
              .where('backlinks.targetPath', '=', path),
          ),
        )
      })
      .select(['notes.path as sourcePath', 'notes.title as sourceTitle'])
      .orderBy(sourceRecency, 'desc')
      .orderBy('notes.path')
      .limit(MAX_READS)
      .execute()
  }

  /**
   * One entry per line of `content` that mentions a name, in document order,
   * each line as plain text by the note's own parse (so a construct that
   * opened on an earlier line still reads cleanly). Nothing when the content
   * already links to the target: the index may not have caught up yet.
   */
  #mentionLines(
    candidate: CandidateSource,
    content: string,
    names: readonly string[],
  ): SuggestedBacklink[] {
    const prepared = prepareBlockContext(content)
    if (linksToAnyName(prepared, names)) {
      return []
    }
    const mentions = findNoteMentions(prepared, names)
    if (mentions.length === 0) {
      return []
    }
    const { body, bodyOffset } = prepared
    const { cuts, literalRanges } = plainTextSpans(prepared.tree)
    const lines = new Map<number, SuggestedBacklink>()
    for (const mention of mentions) {
      const position = mention.from - bodyOffset
      const lineStart = lineStartAt(body, position)
      if (!lines.has(lineStart)) {
        lines.set(lineStart, {
          sourcePath: candidate.sourcePath,
          sourceTitle: candidate.sourceTitle,
          line: plainTextOfRange(body, lineStart, lineEndAt(body, position), cuts, literalRanges),
          mention,
        })
      }
    }
    return [...lines.values()]
  }
}

export function createSuggestedBacklinkService(
  deps: SuggestedBacklinkServiceDeps,
): SuggestedBacklinkService {
  return new SuggestedBacklinkServiceImpl(deps)
}
