import { unzipSync } from 'fflate'
import { z } from 'zod'
import { dailyPath, notePath } from '../graph/paths'
import { noteExists, writeNote } from '../graph/commands'
import { availableNotePath } from '../indexing/note-paths'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import { slugForTitle } from '../markdown/slug'

/** Progress for a Reflect markdown zip import. */
export interface ReflectMarkdownImportProgress {
  /** Entries already processed, including skipped markdown entries. */
  done: number
  /** Markdown entries discovered in the archive. */
  total: number
}

/** Summary of notes written from a Reflect markdown zip import. */
export interface ReflectMarkdownImportResult {
  /** Total notes written into the graph. */
  imported: number
  /** Regular notes written under `notes/`. */
  regular: number
  /** Daily notes written under `daily/`. */
  daily: number
  /** Markdown entries ignored because they could not be mapped safely. */
  skipped: number
  /** Notes whose target path was changed to avoid an overwrite. */
  renamed: number
}

export interface ReflectMarkdownImportOptions {
  /** Open graph file-write generation; passed through to every note write. */
  generation: number
  /** Optional callback after each markdown entry is processed. */
  onProgress?: (progress: ReflectMarkdownImportProgress) => void
}

interface ZipMarkdownEntry {
  readonly archivePath: string
  readonly bytes: Uint8Array
}

interface PlannedImport {
  readonly path: string
  readonly contents: string
  readonly kind: 'daily' | 'regular'
  readonly renamed: boolean
}

const zipMarkdownEntrySchema = z.object({
  archivePath: z.string().min(1),
  bytes: z.instanceof(Uint8Array),
})

const DAILY_EXPORT_PATH_RE = /(?:^|\/)daily-notes\/(\d{4}-\d{2}-\d{2})\.md$/i
const MARKDOWN_PATH_RE = /\.md$/i
const LEADING_H1_RE = /^#\s+(.+?)\s*$/m
const TASK_PLUS_RE = /^([ \t]*)\+([ \t]+\[[ xX]\])/gm
const ORDINAL_DAY_RE = /^(\d{1,2})(?:st|nd|rd|th)?$/i

const MONTHS = new Map([
  ['january', 1],
  ['february', 2],
  ['march', 3],
  ['april', 4],
  ['may', 5],
  ['june', 6],
  ['july', 7],
  ['august', 8],
  ['september', 9],
  ['october', 10],
  ['november', 11],
  ['december', 12],
])

/**
 * Import the markdown zip produced by Reflect v1's Markdown export into the
 * currently open Reflect v2 graph. Regular note filenames are re-derived from
 * titles, V1 note ids are preserved in frontmatter, daily notes land under
 * `daily/YYYY-MM-DD.md`, and existing graph files are never overwritten.
 */
export async function importReflectMarkdownZip(
  data: ArrayBuffer | Uint8Array,
  options: ReflectMarkdownImportOptions,
): Promise<ReflectMarkdownImportResult> {
  const entries = readMarkdownEntries(data)
  const reserved = new Set<string>()
  const result: ReflectMarkdownImportResult = {
    imported: 0,
    regular: 0,
    daily: 0,
    skipped: 0,
    renamed: 0,
  }

  let done = 0
  for (const entry of entries) {
    const planned = await planImport(entry, reserved)
    if (planned === null) {
      result.skipped += 1
    } else {
      await writeNote(planned.path, planned.contents, options.generation)
      result.imported += 1
      result[planned.kind] += 1
      if (planned.renamed) {
        result.renamed += 1
      }
    }
    done += 1
    options.onProgress?.({ done, total: entries.length })
  }

  return result
}

function readMarkdownEntries(data: ArrayBuffer | Uint8Array): ZipMarkdownEntry[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const unzipped = unzipSync(bytes)
  return Object.entries(unzipped)
    .filter(([archivePath]) => isImportableMarkdownPath(archivePath))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([archivePath, entryBytes]) => zipMarkdownEntrySchema.parse({ archivePath, bytes: entryBytes }))
}

function isImportableMarkdownPath(archivePath: string): boolean {
  return (
    !archivePath.endsWith('/') &&
    !archivePath.startsWith('__MACOSX/') &&
    MARKDOWN_PATH_RE.test(archivePath)
  )
}

async function planImport(
  entry: ZipMarkdownEntry,
  reserved: Set<string>,
): Promise<PlannedImport | null> {
  const source = normalizeMarkdown(decodeUtf8(entry.bytes))
  const dailyDate = dailyDateForEntry(entry.archivePath, source)
  if (dailyDate !== null) {
    return planDailyImport(dailyDate, source, reserved)
  }
  return planRegularImport(entry.archivePath, source, reserved)
}

async function planDailyImport(
  date: string,
  source: string,
  reserved: Set<string>,
): Promise<PlannedImport | null> {
  const body = ensureFinalNewline(normalizeTaskMarkers(stripDailyHeading(source)))
  const targetPath = safeDailyPath(date)
  if (targetPath === null) {
    return null
  }
  if (!(await isTaken(targetPath, reserved))) {
    reserved.add(targetPath)
    return { path: targetPath, contents: body, kind: 'daily', renamed: false }
  }

  const title = `Daily ${date}`
  const path = await reserveAvailableNotePath(slugForTitle(title), reserved)
  return {
    path,
    contents: ensureFinalNewline(`# ${title}\n\n${body}`),
    kind: 'regular',
    renamed: true,
  }
}

function safeDailyPath(date: string): string | null {
  try {
    return dailyPath(date)
  } catch {
    return null
  }
}

async function planRegularImport(
  archivePath: string,
  source: string,
  reserved: Set<string>,
): Promise<PlannedImport> {
  const stem = basename(archivePath).replace(/\.md$/i, '')
  const title = firstHeadingTitle(source) ?? stem
  const id = extractV1Id(stem, title)
  const slug = slugForTitle(title)
  const path = await reserveAvailableNotePath(slug, reserved)
  const contents = ensureFinalNewline(withImportedId(normalizeTaskMarkers(source), id))
  return {
    path,
    contents,
    kind: 'regular',
    renamed: path !== notePath(slug),
  }
}

async function reserveAvailableNotePath(slug: string, reserved: Set<string>): Promise<string> {
  const path = await availableNotePath(slug, (candidate) => isTaken(candidate, reserved))
  reserved.add(path)
  return path
}

async function isTaken(path: string, reserved: Set<string>): Promise<boolean> {
  return reserved.has(path) || (await noteExists(path))
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

function normalizeMarkdown(source: string): string {
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

function normalizeTaskMarkers(source: string): string {
  return source.replace(TASK_PLUS_RE, '$1-$2')
}

function stripDailyHeading(source: string): string {
  const [firstLine = '', ...rest] = source.split('\n')
  if (parseDailyHeadingDate(firstLine) === null) {
    return source
  }
  return rest.join('\n').replace(/^(?:[ \t]*\n)+/, '')
}

function ensureFinalNewline(source: string): string {
  return source === '' || source.endsWith('\n') ? source : `${source}\n`
}

function dailyDateForEntry(archivePath: string, source: string): string | null {
  const filenameDate = DAILY_EXPORT_PATH_RE.exec(archivePath)?.[1] ?? null
  if (filenameDate === null) {
    return null
  }
  const headingDate = parseDailyHeadingDate(source.split('\n', 1)[0] ?? '')
  return headingDate ?? filenameDate
}

function parseDailyHeadingDate(line: string): string | null {
  if (!line.startsWith('# ')) {
    return null
  }
  const label = line.slice(2).trim()
  const withoutWeekday = label.replace(/^[A-Za-z]+,\s+/, '')
  const parts = withoutWeekday.split(/\s+/)
  if (parts.length !== 3) {
    return null
  }
  const [first, second, third] = parts
  if (first === undefined || second === undefined || third === undefined) {
    return null
  }

  if (MONTHS.has(first.toLowerCase())) {
    return isoDate(third, first, second.replace(/,$/, ''))
  }

  return isoDate(third, second.replace(/,$/, ''), first)
}

function isoDate(yearText: string, monthText: string, dayText: string): string | null {
  const year = Number(yearText.replace(/,$/, ''))
  const month = MONTHS.get(monthText.toLowerCase())
  const dayMatch = ORDINAL_DAY_RE.exec(dayText.replace(/,$/, ''))
  if (!Number.isInteger(year) || month === undefined || dayMatch === null) {
    return null
  }
  const day = Number(dayMatch[1])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-')
}

function firstHeadingTitle(source: string): string | null {
  const body = splitFrontmatter(source).body
  const match = LEADING_H1_RE.exec(body)
  return match?.[1]?.trim() || null
}

function extractV1Id(stem: string, title: string): string | null {
  const safeTitle = sanitizeV1Filename(title)
  const expectedPrefix = `${safeTitle}-`
  if (stem.startsWith(expectedPrefix)) {
    const id = stem.slice(expectedPrefix.length).trim()
    return id === '' ? null : id
  }

  const lastHyphen = stem.lastIndexOf('-')
  if (lastHyphen === -1 || lastHyphen === stem.length - 1) {
    return null
  }
  return stem.slice(lastHyphen + 1).trim() || null
}

function sanitizeV1Filename(title: string): string {
  return title.replace(/[/\\]/g, '').replace(/\s+/g, ' ').trim()
}

function withImportedId(source: string, id: string | null): string {
  if (id === null) {
    return source
  }
  const split = splitFrontmatter(source)
  if (split.raw !== null) {
    const parsed = parseFrontmatter(split.raw)
    if (parsed.warning !== undefined || parsed.data.id !== undefined) {
      return source
    }
  }
  return upsertFrontmatter(source, { id })
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path
}
