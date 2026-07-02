import { TEXT_CAPTURE_MAX_LENGTH, type TextCaptureKind } from '@reflect/core'
import type { Route } from '@/routing/route'

/**
 * The `reflect://` deep-link vocabulary (docs/deep-links.md). URLs are a codec
 * over the existing {@link Route} union plus two capture verbs — never a
 * second navigation grammar. `parse.ts` and `format.ts` are the only modules
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
 * A parsed deep link:
 *
 * - `navigate` — self-contained routes (`today`, `daily/<date>`, `search`,
 *   `tasks`) that map straight onto {@link Route}.
 * - `openNote` — `note/<target>`, where `<target>` still needs resolution
 *   (frontmatter id → date → title → alias) against the open graph's index.
 * - `capture` — `append`/`task` write links, spooled into `.reflect/inbox/`.
 *   The capture kind is core's {@link TextCaptureKind} — the URL verb, the
 *   envelope kind, and the drain behavior share the one vocabulary.
 */
export type DeepLink =
  | { kind: 'navigate'; route: Route }
  | { kind: 'openNote'; target: string }
  | { kind: 'capture'; capture: TextCaptureKind; text: string }
