/**
 * Size caps on a captured post (Plan 25), shared by the envelope schema, the
 * host's serde mirror (by hand), and the extension's page extractor. Kept
 * dependency-free and exported as `@reflect/core/post-limits` so the content
 * script that runs on x.com can clip text without pulling zod and the schema
 * construction into its bundle.
 */

/** Cap on a captured post's text (and a quoted post's), in UTF-16 units. */
export const POST_TEXT_MAX_LENGTH = 10_000

/** Cap on media attachments per post — X's own limit. */
export const POST_MEDIA_MAX = 4

/** Cap on an author's display name. */
export const POST_AUTHOR_NAME_MAX_LENGTH = 200

/** Cap on a media item's alt text. */
export const POST_MEDIA_ALT_MAX_LENGTH = 1000
