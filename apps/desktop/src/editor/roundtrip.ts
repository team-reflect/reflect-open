/**
 * Round-trip safety guard (Plan 05b). Markdown is the durable source of truth,
 * so before the save pipeline rewrites a note, the editor must be able to
 * reproduce it. meowdown owns the classifier; it is re-exported here so the
 * rest of the app keeps importing it from one place. A `lossy` result opens the
 * note protected (read-only) rather than letting a converter gap silently
 * rewrite the file.
 */
export { checkRoundTrip, type RoundTripFidelity } from '@meowdown/core'
