import { TEXT_CAPTURE_MAX_LENGTH, type TextCaptureKind } from '../capture/capture-envelope.ts'

/**
 * The `reflect://` deep-link vocabulary (docs/deep-links.md). URLs are a codec
 * over the places the app can open (`today`, `tasks`, a daily note, a search, a note)
 * plus two capture verbs — never a second navigation grammar. `deep-link-parse.ts` and `deep-link-format.ts` are the only modules
 * that read or write this syntax.
 */

/** The URL scheme the app registers (`plugins.deep-link` in tauri.conf.json). */
export const DEEP_LINK_SCHEME = 'reflect'

/**
 * Cap on capture-link text (`append`/`task`) — the envelope schema's own cap,
 * enforced here too so an over-long URL is rejected before an envelope is
 * built; the Rust spool command adds a byte cap behind both.
 */
export const DEEP_LINK_TEXT_MAX_LENGTH = TEXT_CAPTURE_MAX_LENGTH

/**
 * A place a deep link addresses with no lookup: the `today`, `tasks`,
 * `daily/<date>` and `search` verbs.
 */
export type DeepLinkPlace =
  | { kind: 'today' }
  | { kind: 'tasks' }
  | { kind: 'daily'; date: string }
  | { kind: 'search'; query: string }

/**
 * A parsed deep link:
 *
 * - `navigate` — self-contained places (`today`, `daily/<date>`, `search`,
 *   `tasks`).
 * - `openNote` — `note/<target>`, where `<target>` still needs resolution
 *   (frontmatter id → date → title → alias) against the open graph's index.
 * - `capture` — `append`/`checkbox`/`task` write links, spooled into `.reflect/inbox/`.
 *   The capture kind is {@link TextCaptureKind} — the URL verb, the
 *   envelope kind, and the drain behavior share the one vocabulary.
 */
export type DeepLink =
  | { kind: 'navigate'; place: DeepLinkPlace }
  | { kind: 'openNote'; target: string }
  | { kind: 'capture'; capture: TextCaptureKind; text: string }
