/**
 * Old Reflect started every note on a single `-` bullet. The
 * `editorDefaultBullet` setting (on by default) restores that: a note that
 * opens with an empty body shows one empty bullet, caret inside, ready to type.
 *
 * The bullet is an **editor display seed**, never persisted on its own. meowdown
 * parses `- ` to a single empty list item, and an empty list item serializes
 * back to nothing (`docToMarkdown` drops it) — so the editor shows a bullet
 * while the document still reads as empty. Nothing is written until the user
 * types real content, which keeps a not-yet-created daily-note placeholder
 * uncreated (the lazy no-litter contract). The seam lives here, at the editor,
 * rather than in the save pipeline: seeding the document model with the literal
 * `- ` markdown would classify lossy and open the note read-only.
 */

/** The markdown that renders as a single empty bullet with the caret inside. */
export const EMPTY_BULLET_SEED = '- '

/**
 * The markdown to seed the editor with for a note whose stored body is `body`.
 * When `startWithBullet` is on and the body is empty (or whitespace only), that
 * is a single empty bullet; otherwise it is the body unchanged. A titled new
 * note keeps its `#` heading body, so it is never seeded with a bullet.
 */
export function editorBodyWithDefaultBullet(body: string, startWithBullet: boolean): string {
  return startWithBullet && body.trim() === '' ? EMPTY_BULLET_SEED : body
}
