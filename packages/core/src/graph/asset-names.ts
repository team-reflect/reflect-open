import { slugForTitle } from '../markdown/slug'

/**
 * Extensions are advisory (they pick the OS opener), so a short alphanumeric
 * cap is plenty and keeps a crafted "extension" from smuggling junk into the
 * filename.
 */
const MAX_EXTENSION_CHARS = 12

/**
 * Derive the on-disk filename for an imported attachment from its original
 * name: the stem goes through the graph's frozen readable-filename rules
 * (`slugForTitle` — lowercase, separator collapsing, Windows-reserved
 * handling), inner dots become dashes (`archive.tar.gz` → `archive-tar.gz`),
 * and the extension is kept, lowercased and stripped to alphanumerics. The
 * original name survives as the markdown link *text*; this is only the file
 * on disk. Collision suffixes (`-2`) are Rust's job at write time.
 *
 * ```ts
 * assetFileName('Q3 Report (final).PDF') // 'q3-report-final.pdf'
 * assetFileName('archive.tar.gz')        // 'archive-tar.gz'
 * assetFileName('.env')                  // 'env'
 * assetFileName('???')                   // 'untitled'
 * ```
 */
export function assetFileName(originalName: string): string {
  const trimmed = originalName.normalize('NFC').trim()
  const dotIndex = trimmed.lastIndexOf('.')
  const hasExtension = dotIndex > 0 && dotIndex < trimmed.length - 1
  const stem = hasExtension ? trimmed.slice(0, dotIndex) : trimmed
  const extension = hasExtension
    ? trimmed
        .slice(dotIndex + 1)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, MAX_EXTENSION_CHARS)
    : ''
  const slug = slugForTitle(stem.replaceAll('.', '-'))
  return extension === '' ? slug : `${slug}.${extension}`
}
