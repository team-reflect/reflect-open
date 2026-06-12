/**
 * Title → filename slug derivation: regular notes live at `notes/<slug>.md`,
 * and this module is the **only author** of that slug — the filename is a
 * projection of the title, never edited directly. Output must be safe on
 * every filesystem a graph can sync to: lowercase-only is load-bearing (it
 * makes APFS/NTFS case-insensitivity and git case-sensitivity agree by
 * construction), and non-Latin scripts pass through untransliterated — a CJK
 * title keeps its characters.
 *
 * The rules are **frozen** by the golden corpus in `slug.test.ts`: a silent
 * change here would re-slug every title differently — a rename storm across
 * graphs. Treat a corpus failure as a breaking-change gate, not a test to
 * update.
 *
 * The full system — births, renames, healing — is documented in
 * `docs/readable-filenames.md`.
 */

/**
 * Windows reserved device names (case-insensitive, extension-less). A file
 * named `con.md` is uncreatable or hazardous on Windows, so these slugs get a
 * `-note` suffix.
 */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

/**
 * Maximum slug length in code points. One cap serves both budgets: titles can
 * be sentences but a filename shouldn't be, and filesystems cap basenames at
 * 255 *bytes* — `\p{L}` admits astral-plane letters at 4 UTF-8 bytes each, so
 * 60 points is at most 240 bytes, leaving room for `notes/`, `.md`, and a
 * collision suffix.
 */
const MAX_SLUG_CHARS = 60

/** Anything that isn't a letter, number, or separator is dropped outright. */
const STRIP_RE = /[^\p{L}\p{N}\s_-]+/gu
/** Separator runs (whitespace, `_`, `-`) collapse to a single `-`. */
const SEPARATOR_RE = /[\s_-]+/gu
const EDGE_DASHES_RE = /^-+|-+$/g

/**
 * Derive the filename slug for a note title: NFC-normalize, lowercase
 * (Unicode-aware), drop everything but letters/numbers/separators, collapse
 * separator runs to single `-`, trim edge dashes, cap at
 * {@link MAX_SLUG_CHARS} code points (never splitting a surrogate pair).
 * Never empty (`untitled`), never a Windows reserved device name.
 * Idempotent: a slug slugs to itself.
 *
 * ```ts
 * slugForTitle('Meeting Notes')   // 'meeting-notes'
 * slugForTitle("Don't Panic!")    // 'dont-panic'
 * slugForTitle('日本語ノート')      // '日本語ノート'
 * slugForTitle('🎉🎉🎉')           // 'untitled'
 * slugForTitle('CON')             // 'con-note'
 * ```
 */
export function slugForTitle(title: string): string {
  const folded = title.normalize('NFC').toLowerCase()
  const dashed = folded
    .replace(STRIP_RE, '')
    .replace(SEPARATOR_RE, '-')
    .replace(EDGE_DASHES_RE, '')
  // Cap on code points, then re-trim: the cut can land right after a dash.
  const capped = [...dashed].slice(0, MAX_SLUG_CHARS).join('').replace(EDGE_DASHES_RE, '')
  if (capped === '') {
    return 'untitled'
  }
  if (WINDOWS_RESERVED.has(capped)) {
    return `${capped}-note`
  }
  return capped
}
