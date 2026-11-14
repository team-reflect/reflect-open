import { isIsoDate } from '@reflect/utils'
import type {
  IndexedAlias,
  IndexedClaim,
  IndexedEmail,
  IndexedLink,
  IndexedNote,
  IndexedTag,
  IndexedTask,
  NoteKind,
} from '@reflect/types'
import { z } from 'zod'
import {
  markdownNoteReference,
  noteBasenameKey,
  wikiNoteReference,
} from '../graph/note-reference.ts'
import { dateFromDailyPath, foldGraphPath, isDaily, isTemplatePath } from '../graph/paths.ts'
import { hasSearchableChar } from '../lib/searchable-char.ts'
import {
  canonicalEmail,
  encodeTaskPath,
  extractEmailFields,
  foldKey,
  foldTag,
  gistBodyHash,
  isPinned,
  pinnedOrder,
  splitFrontmatter,
  subjectAliases,
  wikiLinkTargetForTitle,
  type ParsedNote,
} from '../markdown/index.ts'
import { previewSnippet } from './snippet.ts'
import { serializeWikiSuggestionAddress } from './suggest.ts'

/**
 * The index write payload (Plan 04): a {@link ParsedNote} (Plan 03) flattened into
 * the row-set the Rust `index_apply` command upserts. Pure — no IO — so it's the
 * unit-testable heart of the pipeline.
 *
 * The payload types are generated from `crates/types/src/index.rs`.
 */

/**
 * Version of the projection {@link buildIndexedNote} produces. Bump it whenever
 * the rows derived from an *unchanged* file change — a new column, a changed
 * derivation — so `NoteIndexer.sync` rebuilds graphs whose rows predate it. The
 * hash-based reconcile alone would never re-index an unchanged file, leaving
 * new columns at their migration defaults forever.
 *
 * History: 1 — Plan 04 baseline · 2 — `notes.preview` + `tags.tag_key` (the
 * first stamped version; v2 rows also carry the 0004 pinned columns) ·
 * 3 — repairs `notes.mtime` 0 rows written by the watcher path before it
 * carried `modifiedMs` (hash-reconcile can never refresh them) ·
 * 4 — retained `notes.has_conflict` column, no longer written or read ·
 * 5 — `notes.gist_url` + `notes.gist_stale` (gist publishing) ·
 * 6 — rendered Markdown escapes in titles, wiki-link targets, and previews ·
 * 7 — `tasks` projection (GFM checkboxes, Plan 18): existing notes carry no task
 * rows until reprojected, so the bump backfills them ·
 * 8 — `tasks.due_date` (explicit `[[YYYY-MM-DD]]` per task, V1 Overdue semantics):
 * existing task rows have a null due date until reprojected.
 * 9 — asset descriptions folded into `search_fts.body` (Plan 20 search
 * integration): existing notes carry no asset-description text in search until
 * reprojected, so the bump rebuilds them.
 * 10 — asset reference paths fully canonicalized (`./`, `..`, empty segments
 * collapsed, not just percent-decoded): the `assets` projection's keys change,
 * so the bump rebuilds them — the privacy gate matches them against the
 * canonical on-disk path.
 * 11 — `tasks` projection limited to round Meowdown task checkboxes (`+ [ ]` /
 * `+ [x]`), excluding square checklist checkboxes from the aggregate Tasks view.
 * 12 — `notes.kind` (daily / note / template): templates are indexed but
 * excluded from note surfaces, so rows must carry the kind.
 * 13 — `note_emails` projection (`- Email:` contact-field bullets): existing
 * person notes carry no email rows until reprojected, and attendee → note
 * resolution in the calendar flow needs them, so the bump backfills them.
 * 14 — v1 subject aliases (`//` segments of the title) folded into the
 * `aliases` projection: existing v1-style titles carry no derived alias rows
 * until reprojected, so the bump backfills them.
 * 15 — task parent outline/list breadcrumbs: existing task rows carry empty
 * breadcrumbs until reprojected.
 * 16 - meowdown-aligned wiki-link parsing (the editor's own `gfmParser`) and
 * derived linkable aliases for rich titles and rich frontmatter aliases:
 * existing notes must reproject for both the recovery-semantics convergence
 * and the backfilled alias rows.
 * 17 - legacy nested `Email` / `Emails` contact fields and canonical email
 * identities: unchanged V1 person notes need their `note_emails` rows rebuilt.
 * 18 - path addressing (`notes.path_key`, `links.target_path_key`) and the
 * `note_claims` projection that replaces the tiered `note_keys` derivation:
 * existing rows carry no claims and no path keys, so vault-path links and
 * filename-stem links stay unresolved until reprojected. Name keys also gain
 * NFC folding (`foldKey`), so NFD-spelled titles need their keys rebuilt.
 * 19 - wiki `links.target_key` becomes the classifier's name key (fragment
 * and `.md` stripped; '' for strict-path, self, and refused targets), so the
 * backlinks view's name join matches navigation. Existing rows carry the raw
 * fold and must reproject.
 * 20 - `notes.has_content` records whether a note would render blank, and
 * `search_fts.body` now carries the raw Markdown body, so every note must
 * reproject.
 * 21 - tasks are keyed by AST path (`tasks.ast_path`) and store Markdown instead
 * of plain text, so every note's tasks must reproject.
 * 22 - task breadcrumbs start with the chain of headings above the task (the
 * `Tasks` heading included), so every note's tasks must reproject.
 */
export const PROJECTION_VERSION = 22

/**
 * Precedence of the spellings a note answers to (`note_claims.tier`): the
 * lowest tier claiming a key wins it. The numbers are the storage encoding —
 * migration 0019 and the CLI read the same values.
 */
export const CLAIM_TIER = {
  /** Calendar-valid daily date (`daily/2026-07-26.md` answering to `2026-07-26`). */
  dailyDate: 1,
  /** Authored title (frontmatter or first heading; filename when untitled). */
  title: 2,
  /** Frontmatter or derived alias. */
  alias: 3,
  /** Filename stem — the weakest address, how Obsidian names every note. */
  basename: 4,
} as const

export type {
  IndexedAlias,
  IndexedClaim,
  IndexedEmail,
  IndexedLink,
  IndexedNote,
  IndexedTag,
  IndexedTask,
  NoteKind,
}

const taskBreadcrumbsSchema = z.array(z.string()).readonly()

/**
 * The `tasks.breadcrumbs` column's format: the ordered label array as one JSON
 * string. Every writer and reader of the column goes through this pair (or,
 * in Rust, `write.rs`'s `serde_json` mirror — the db tests pin that parity).
 */
export function encodeTaskBreadcrumbs(breadcrumbs: readonly string[]): string {
  return JSON.stringify(breadcrumbs)
}

export function decodeTaskBreadcrumbs(column: string): readonly string[] {
  return taskBreadcrumbsSchema.parse(JSON.parse(column))
}

/**
 * The `aliases` projection: `aliases:` frontmatter verbatim, then the linkable
 * form of any rich title or rich frontmatter alias ({@link wikiLinkTargetForTitle}),
 * then the v1 subject aliases derived from the title (`Charlotte MacCaw // Mum`);
 * later stages skip keys an earlier row already claims. The derived rows are
 * index-only — the file's frontmatter is never rewritten to hold them. A
 * linkable-form row is only projected when it is an address `note_keys` can
 * actually serve: distinct from its source's key and serializable as wiki-link
 * text ({@link serializeWikiSuggestionAddress}). Shared with the disk-fallback
 * resolver so index and disk derive one truth (exported as `projectNoteAliases`).
 */
export function projectNoteAliases(parsed: ParsedNote): IndexedAlias[] {
  const aliases: IndexedAlias[] = parsed.frontmatter.aliases.map((alias) => ({
    alias,
    aliasKey: foldKey(alias),
  }))
  const claimed = new Set(aliases.map((row) => row.aliasKey))
  for (const richText of [parsed.title, ...parsed.frontmatter.aliases]) {
    const linkTarget = wikiLinkTargetForTitle(richText)
    const linkTargetKey = foldKey(linkTarget)
    if (
      linkTargetKey === foldKey(richText) ||
      claimed.has(linkTargetKey) ||
      serializeWikiSuggestionAddress(linkTarget, null) === null
    ) {
      continue
    }
    claimed.add(linkTargetKey)
    aliases.push({ alias: linkTarget, aliasKey: linkTargetKey })
  }
  for (const alias of subjectAliases(parsed.title)) {
    const aliasKey = foldKey(alias)
    if (claimed.has(aliasKey)) {
      continue
    }
    claimed.add(aliasKey)
    aliases.push({ alias, aliasKey })
  }
  return aliases
}

/**
 * Every folded spelling this note answers to, with the tier that settles a
 * contest against another note. Templates claim nothing: they are reachable
 * only through an explicit `templates/…` path.
 *
 * A note with no authored title already carries its filename as its title
 * (`deriveTitle`), so the filename tier only adds an address for a note
 * whose H1 or frontmatter title differs from its filename. A key a stronger
 * tier already claims is skipped, so `claim_count` counts notes, not
 * spellings.
 */
export function projectNoteClaims(
  parsed: ParsedNote,
  aliases: readonly IndexedAlias[],
): IndexedClaim[] {
  if (isTemplatePath(parsed.path)) {
    return []
  }
  const claims: IndexedClaim[] = []
  const seen = new Set<string>()
  const claim = (key: string, tier: number): void => {
    if (key !== '' && !seen.has(key)) {
      seen.add(key)
      claims.push({ key, tier })
    }
  }
  const date = isDaily(parsed.path) ? dateFromDailyPath(parsed.path) : null
  if (date !== null && isIsoDate(date)) {
    claim(date, CLAIM_TIER.dailyDate)
  }
  claim(foldKey(parsed.title), CLAIM_TIER.title)
  for (const alias of aliases) {
    claim(alias.aliasKey, CLAIM_TIER.alias)
  }
  claim(noteBasenameKey(parsed.path), CLAIM_TIER.basename)
  return claims
}

/**
 * Flatten a parsed note into the index payload. `meta.source` is the raw
 * markdown the note was parsed from.
 */
export function buildIndexedNote(
  parsed: ParsedNote,
  meta: { fileHash: string; mtime: number; source: string; assetText?: string },
): IndexedNote {
  const wikiLinks: IndexedLink[] = parsed.wikiLinks.map((link) => {
    const reference = wikiNoteReference(link.target)
    const hasNameReading = reference?.kind === 'key' || reference?.kind === 'pathOrKey'
    return {
      kind: 'wiki' as const,
      targetRaw: link.target,
      // The classifier's own name key (fragment and `.md` stripped), so the
      // backlinks view joins exactly what navigation resolves. Empty when the
      // target has no name reading (a rooted path, `#self`, a refused URI):
      // no claim is ever '', so those rows can never name-join.
      targetKey: hasNameReading ? reference.key : '',
      targetPathKey:
        reference?.kind === 'path' || reference?.kind === 'pathOrKey'
          ? foldGraphPath(reference.path)
          : null,
      alias: link.alias ?? null,
      posFrom: link.from,
      posTo: link.to,
    }
  })
  const mdLinks: IndexedLink[] = parsed.links.map((link) => {
    const reference = markdownNoteReference(parsed.path, link.href)
    return {
      kind: 'md' as const,
      targetRaw: link.href,
      targetKey: link.href.toLowerCase(),
      targetPathKey: reference?.kind === 'path' ? foldGraphPath(reference.path) : null,
      alias: null,
      posFrom: link.from,
      posTo: link.to,
    }
  })
  const aliases = projectNoteAliases(parsed)
  const body = splitFrontmatter(meta.source).body

  return {
    path: parsed.path,
    id: parsed.id ?? null,
    title: parsed.title,
    titleKey: foldKey(parsed.title),
    pathKey: foldGraphPath(parsed.path),
    kind: isDaily(parsed.path) ? 'daily' : isTemplatePath(parsed.path) ? 'template' : 'note',
    dailyDate: isDaily(parsed.path) ? dateFromDailyPath(parsed.path) : null,
    isPrivate: parsed.frontmatter.private,
    isPinned: isPinned(parsed.frontmatter),
    pinnedOrder: pinnedOrder(parsed.frontmatter),
    gistUrl: parsed.frontmatter.gist?.url ?? null,
    // Staleness is a body-hash comparison (frontmatter excluded): publishing
    // writes the `gist` block itself, and a pin/private toggle is not an edit
    // worth a "republish" nudge.
    gistStale:
      parsed.frontmatter.gist !== undefined && gistBodyHash(body) !== parsed.frontmatter.gist.hash,
    fileHash: meta.fileHash,
    mtime: meta.mtime,
    text: body,
    assetText: meta.assetText ?? '',
    preview: previewSnippet(parsed.displayText, parsed.title),
    hasContent: parsed.displayText !== '' || hasSearchableChar(body),
    links: [...wikiLinks, ...mdLinks],
    tags: parsed.tags.map((tag) => ({ tag, tagKey: foldTag(tag) })),
    aliases,
    claims: projectNoteClaims(parsed, aliases),
    emails: extractEmailFields(body).map((email) => ({ email, emailKey: canonicalEmail(email) })),
    // One reference can contribute several candidate spellings; the
    // projection stores each path once.
    assets: [...new Set(parsed.assets.map((asset) => asset.path))],
    tasks: parsed.tasks.map((task) => ({
      astPath: encodeTaskPath(task.astPath),
      markdown: task.markdown,
      breadcrumbs: [...task.breadcrumbs],
      checked: task.checked,
      dueDate: task.dueDate,
    })),
  }
}
