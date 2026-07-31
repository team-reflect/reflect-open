import type { GistFrontmatter } from '@reflect/core'

export interface FrontmatterPatch {
  /**
   * The durable note identity (Plan 17's ULID). Only ever *minted* — written
   * once for a note that predates ids or was created outside Reflect (the
   * deep-link copy path) — never changed or removed: links and the index key
   * on it.
   */
  id?: string
  /** Alternative wiki-link titles for this note (the Plan 07b auto-alias). */
  aliases?: string[]
  /**
   * Sidebar pin. `true` pins; a number pins with an explicit order (what the
   * pinned shelf reorder writes); `false` deletes the key rather than writing
   * `pinned: false` — unpinned is the absence of the flag, and a note whose
   * only metadata was the pin returns to having no frontmatter at all.
   */
  pinned?: boolean | number
  /**
   * The hard privacy flag (`private: true`): the note's content must never be
   * sent to AI or any other external service. `false` deletes the key — like
   * the pin, not-private is the absence of the flag.
   */
  private?: boolean
  /**
   * The published GitHub Gist block (id, url, file, hash of the published
   * body) — written whole after every publish. `false` removes the block when
   * the user unpublishes the link.
   */
  gist?: GistFrontmatter | false
  /**
   * Contact names whose suggested-contact card was dismissed on this note —
   * written whole, like `aliases`. The empty list deletes the key: with no
   * dismissals the frontmatter carries nothing.
   */
  ignoredContacts?: string[]
}

/**
 * Translate the typed patch into the YAML write (`undefined` deletes a key).
 * Exported so the disk-fallback write (`commitNoteFrontmatter`) encodes a flag
 * byte-for-byte the same way the live session does — one translation, no drift.
 */
export function frontmatterPatchToYaml(patch: FrontmatterPatch): Record<string, unknown> {
  const yaml: Record<string, unknown> = {}
  if (patch.id !== undefined) {
    yaml['id'] = patch.id
  }
  if (patch.aliases !== undefined) {
    yaml['aliases'] = patch.aliases
  }
  if (patch.pinned !== undefined) {
    yaml['pinned'] = patch.pinned === false ? undefined : patch.pinned
  }
  if (patch.private !== undefined) {
    yaml['private'] = patch.private === false ? undefined : true
  }
  if (patch.ignoredContacts !== undefined) {
    yaml['ignoredContacts'] = patch.ignoredContacts.length === 0 ? undefined : patch.ignoredContacts
  }
  if (patch.gist !== undefined) {
    if (patch.gist === false) {
      yaml['gist'] = undefined
    } else {
      // Spelled out key-by-key so the YAML block's shape (and key order) is
      // this module's contract, not whatever object the caller happened to hold.
      yaml['gist'] = {
        id: patch.gist.id,
        url: patch.gist.url,
        file: patch.gist.file,
        hash: patch.gist.hash,
      }
    }
  }
  return yaml
}
