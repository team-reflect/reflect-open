/**
 * Pure helpers for the graph's on-disk path conventions (Plan 02). These build
 * and recognize **graph-relative** paths; the Rust layer owns the root and the
 * traversal guard. Shared by every later phase (daily notes, backlinks, CLI).
 */

export const DAILY_DIR = 'daily'
export const NOTES_DIR = 'notes'
/** Note templates — indexed as their own kind, excluded from note surfaces. */
export const TEMPLATES_DIR = 'templates'
export const ASSETS_DIR = 'assets'
/** Audio-memo recordings live apart from pasted/dropped `assets/` files. */
export const AUDIO_MEMOS_DIR = 'audio-memos'

/** Root trees whose Markdown files are attachment metadata, never notes. */
const RESERVED_NOTE_TREES = new Set([ASSETS_DIR, AUDIO_MEMOS_DIR])

/** Obsidian-compatible local attachment formats Reflect can render or open. */
const ATTACHMENT_EXTENSIONS = new Set([
  '3gp',
  'avif',
  'bmp',
  'flac',
  'gif',
  'jpeg',
  'jpg',
  'm4a',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'ogg',
  'ogv',
  'pdf',
  'png',
  'svg',
  'wav',
  'webm',
  'webp',
])

/** A supported content kind at a safe, visible graph-relative path. */
export type GraphPathKind = 'note' | 'attachment'

/**
 * ASCII-only lowering, byte-for-byte the Rust side's `eq_ignore_ascii_case`.
 * Full-Unicode `toLowerCase` folds characters Rust does not (KELVIN SIGN → k),
 * and the two classifiers must never disagree on the same wire path.
 */
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32))
}

/** Matches a daily-note path and captures its ISO date. */
const DAILY_PATH_RE = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/
/** A bare ISO date (`YYYY-MM-DD`). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Graph-relative path to a daily note for an ISO `YYYY-MM-DD` date. */
export function dailyPath(date: string): string {
  if (!ISO_DATE_RE.test(date)) {
    throw new Error(`dailyPath expects an ISO YYYY-MM-DD date, got: ${date}`)
  }
  // Reject well-formatted but invalid dates (e.g. 2026-13-99, 2026-02-31) by
  // round-tripping through UTC and comparing the components. The regex above
  // guarantees three numeric parts, so the destructure can't yield undefined.
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new Error(`dailyPath expects a valid calendar date, got: ${date}`)
  }
  return `${DAILY_DIR}/${date}.md`
}

/** Graph-relative path to a regular note for a filename slug (without `.md`). */
export function notePath(slug: string): string {
  return `${NOTES_DIR}/${slug}.md`
}

/** Graph-relative path to a template for a filename slug (without `.md`). */
export function templatePath(slug: string): string {
  return `${TEMPLATES_DIR}/${slug}.md`
}

/** Graph-relative path to an attachment under `assets/`. */
export function assetPath(name: string): string {
  return `${ASSETS_DIR}/${name}`
}

/** Graph-relative path to a stored recording under `audio-memos/`. */
export function audioMemoPath(name: string): string {
  return `${AUDIO_MEMOS_DIR}/${name}`
}

/**
 * Suffix of a managed asset-description file (Plan 20): the AI description +
 * OCR for an asset lives beside it as `<asset>.reflect.md`.
 */
export const DESCRIPTION_SUFFIX = '.reflect.md'

/** Graph-relative description path for an asset (`assets/x.png` → `assets/x.png.reflect.md`). */
export function descriptionPathFor(assetPath: string): string {
  return `${assetPath}${DESCRIPTION_SUFFIX}`
}

/**
 * Is this graph-relative path an asset under `assets/` (and not a managed
 * description file)? A coarse predicate — it does not check the file
 * extension — used to decide whether a watcher batch is relevant to the
 * asset-description pass; precise eligibility is `isEligibleAssetPath`.
 */
export function isAssetPath(path: string): boolean {
  return path.startsWith(`${ASSETS_DIR}/`) && !path.endsWith(DESCRIPTION_SUFFIX)
}

/** Is this graph-relative path a daily note (`daily/YYYY-MM-DD.md`)? */
export function isDaily(path: string): boolean {
  return DAILY_PATH_RE.test(path)
}

/**
 * Whether every component is a visible, normal graph-relative component.
 * Filesystem walkers must additionally reject symlinks because a lexical path
 * cannot reveal what an entry points at.
 */
export function isSafeVisibleGraphPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) {
    return false
  }
  const components = path.split('/')
  return components.every((component) => component !== '' && !component.startsWith('.'))
}

/**
 * Classify a graph-relative wire path using the cross-platform discovery
 * policy (mirrored by `crates/graph-paths` and pinned by the shared fixture
 * corpus). Notes require an exactly lowercase `.md` suffix. Attachments match
 * their extension case-insensitively. Hidden, absolute, and traversal paths
 * fail closed, while Markdown may otherwise live at the root or any depth.
 */
export function classifyGraphPath(path: string): GraphPathKind | null {
  if (!isSafeVisibleGraphPath(path)) {
    return null
  }
  const components = path.split('/')
  const first = components[0]
  const filename = components.at(-1)
  if (first === undefined || filename === undefined) {
    return null
  }
  const extensionSeparator = filename.lastIndexOf('.')
  if (extensionSeparator < 0 || extensionSeparator === filename.length - 1) {
    return null
  }
  const extension = filename.slice(extensionSeparator + 1)
  if (extension === 'md' && !RESERVED_NOTE_TREES.has(asciiLowerCase(first))) {
    return 'note'
  }
  return ATTACHMENT_EXTENSIONS.has(asciiLowerCase(extension)) ? 'attachment' : null
}

/**
 * Is this graph-relative path an indexable markdown note? The file-change
 * stream carries more than notes — the watcher also reports `audio-memos/`
 * recordings — so consumers that read or index note *content* gate on this.
 * Templates count: they are indexed and editable like notes, just excluded
 * from note surfaces (gate on {@link isTemplatePath} where that matters,
 * e.g. embeddings).
 */
export function isNotePath(path: string): boolean {
  return classifyGraphPath(path) === 'note'
}

/** Is this graph-relative path a supported local attachment? */
export function isAttachmentPath(path: string): boolean {
  return classifyGraphPath(path) === 'attachment'
}

/**
 * Can an eligible note exist below this graph-relative directory? Walkers use
 * this to prune hidden and reserved root trees before descending.
 */
export function mayContainNotes(path: string): boolean {
  if (!isSafeVisibleGraphPath(path)) {
    return false
  }
  const first = path.split('/')[0]
  return first !== undefined && !RESERVED_NOTE_TREES.has(asciiLowerCase(first))
}

/** Is this graph-relative path a note template (`.md` under `templates/`)? */
export function isTemplatePath(path: string): boolean {
  return path.startsWith(`${TEMPLATES_DIR}/`) && isNotePath(path)
}

/** Extract the ISO date from a daily-note path, or `null` if it isn't one. */
export function dateFromDailyPath(path: string): string | null {
  return DAILY_PATH_RE.exec(path)?.[1] ?? null
}
