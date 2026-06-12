/**
 * Title → filename slug derivation (Plan 17). The slug is a *projection* of
 * the title — the only author of regular-note filenames in-app — so its output
 * must be safe on every filesystem a graph can sync to. Lowercase-only output
 * is load-bearing: it makes APFS/NTFS case-insensitivity and git
 * case-sensitivity agree by construction. Non-Latin scripts pass through
 * untransliterated; a CJK title keeps its characters.
 *
 * The rules are frozen by the golden corpus in `slug.test.ts`: a silent change
 * here would re-slug every title differently — a rename storm across graphs.
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
 * Maximum slug length in code points. Titles can be sentences; filenames have
 * byte budgets (255 on APFS/ext4/NTFS). 80 code points caps the worst case
 * (every point 3 UTF-8 bytes) comfortably under the limit with the `notes/`
 * prefix, `.md` suffix, and a collision suffix to spare.
 */
const MAX_SLUG_CHARS = 80

/** Anything that isn't a letter, number, or separator is dropped outright. */
const STRIP_RE = /[^\p{L}\p{N}\s_-]+/gu
/** Separator runs (whitespace, `_`, `-`) collapse to a single `-`. */
const SEPARATOR_RE = /[\s_-]+/gu
const EDGE_DASHES_RE = /^-+|-+$/g

/**
 * Derive the filename slug for a note title: NFC-normalize, lowercase
 * (Unicode-aware), drop everything but letters/numbers/separators, collapse
 * separator runs to single `-`, trim edge dashes, cap at
 * {@link MAX_SLUG_CHARS} code points on a character boundary. Never empty
 * (`untitled`), never a Windows reserved device name. Idempotent: a slug
 * slugs to itself.
 */
export function slugForTitle(title: string): string {
  const folded = title.normalize('NFC').toLowerCase()
  const dashed = folded
    .replace(STRIP_RE, '')
    .replace(SEPARATOR_RE, '-')
    .replace(EDGE_DASHES_RE, '')
  // Cap on code points (never split a surrogate pair), then re-trim: the cut
  // can land right after a dash.
  const capped = [...dashed].slice(0, MAX_SLUG_CHARS).join('').replace(EDGE_DASHES_RE, '')
  if (capped === '') {
    return 'untitled'
  }
  if (WINDOWS_RESERVED.has(capped)) {
    return `${capped}-note`
  }
  return capped
}
