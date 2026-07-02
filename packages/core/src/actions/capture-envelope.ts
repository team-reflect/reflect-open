import { z } from 'zod'

/**
 * The platform-agnostic capture envelope (Plan 11): the contract between
 * every capture producer and the desktop drain. The Chrome extension's
 * native-messaging host writes one `<id>.json` envelope (plus an optional
 * sibling screenshot) into the graph's capture inbox today; the future iOS
 * share extension and Android intent handler write the same shape into their
 * own inboxes. This module is deliberately browser-safe — it imports nothing
 * but zod, and the extension consumes it through the package's
 * `./capture-envelope` subpath without pulling the rest of core.
 *
 * This TS schema is the single source of truth; the Rust host's serde structs
 * (`apps/native-host`) mirror it and must be kept in sync.
 */

/** Where a capture originated. Widens when mobile capture lands. */
export const captureSourceSchema = z.literal('extension')

/** Only web pages are capturable — `chrome://`, `file://` etc. never spool. */
function isHttpUrl(value: string): boolean {
  return value.startsWith('https://') || value.startsWith('http://')
}

/** Standard padded base64 (what `btoa`/`captureVisibleTab` produce). */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** One captured page, as spooled into the capture inbox. */
export const captureEnvelopeSchema = z.object({
  /** Envelope format version; bump on breaking changes. */
  version: z.literal(1),
  /**
   * Producer-generated UUID — names the spool files, dedups host retries.
   * `z.guid()`, not `z.uuid()`: the host's `is_uuid` (apps/native-host) accepts
   * any 8-4-4-4-12 hex string, so the drain must too — `z.uuid()` enforces RFC
   * version/variant nibbles and would quarantine captures the host spooled.
   */
  id: z.guid(),
  /** The captured page's URL. */
  url: z.url().refine(isHttpUrl, 'must be an http(s) url'),
  /** The page title at capture time (may be empty on restricted pages). */
  title: z.string(),
  /** Text the user had selected, verbatim. */
  selection: z.string().optional(),
  /** Plain text paragraphs extracted from the captured page. */
  contentText: z.string().optional(),
  /** A comment the user typed into the capture UI. */
  note: z.string().optional(),
  /**
   * Filename of the sibling screenshot in the spool (e.g. `<id>.jpg`),
   * stamped by the host when the capture carried one.
   */
  screenshotRef: z.string().optional(),
  /** When the capture happened, ISO-8601 — decides the daily note it lands on. */
  capturedAt: z.iso.datetime({ offset: true }),
  /** Where the capture originated. */
  source: captureSourceSchema,
})

export type CaptureEnvelope = z.infer<typeof captureEnvelopeSchema>
export type CaptureSource = z.infer<typeof captureSourceSchema>

/**
 * The extension→host wire message: the envelope plus the screenshot bytes.
 * The host strips `screenshotBase64` into the sibling spool file and stamps
 * `screenshotRef` before writing the envelope. Kept here so the extension and
 * the host tests share one definition of the wire shape.
 */
export const captureWireMessageSchema = z.object({
  envelope: captureEnvelopeSchema.omit({ screenshotRef: true }),
  /** JPEG screenshot bytes, base64 (no data-URL prefix). */
  screenshotBase64: z.string().min(1).regex(BASE64_RE, 'must be base64').optional(),
})

export type CaptureWireMessage = z.infer<typeof captureWireMessageSchema>

/**
 * Cap on a text capture's payload. A `reflect://` URL is a world-invokable
 * surface, so its writes stay short and plain; the desktop's deep-link parser
 * enforces the same number before an envelope is ever spooled.
 */
export const TEXT_CAPTURE_MAX_LENGTH = 10_000

/**
 * What a text capture materializes as on the capture-day daily note. One
 * vocabulary end-to-end: the `reflect://append`/`reflect://task` URL verb IS
 * the envelope kind IS the drain behavior (`- ` bullet / `- [ ]` task).
 */
export const textCaptureKindSchema = z.enum(['append', 'task'])

/**
 * Where a text capture originated. Deliberately separate from
 * {@link captureSourceSchema} and from the envelope *shape*: provenance and
 * shape are different axes, so a future producer (an iOS share sheet, a
 * widget) joins by adding a member here — never by growing a new envelope
 * variant.
 */
export const textCaptureSourceSchema = z.enum(['deep-link'])

/**
 * A text write (`reflect://append?text=…` / `reflect://task?text=…`),
 * spooled into the same capture inbox the native-messaging host writes. One
 * single line of plain text — the drain appends it to the capture-day daily
 * note as a bullet (`append`) or an open task (`task`), so an envelope can
 * never smuggle extra markdown blocks into the graph.
 */
export const textCaptureEnvelopeSchema = z.object({
  /** Envelope format version; bump on breaking changes. */
  version: z.literal(1),
  /** Producer-generated UUID — names the spool file (same rule as link captures). */
  id: z.guid(),
  /** Discriminates from link envelopes, which carry no `kind`. */
  kind: textCaptureKindSchema,
  /** The payload, already whitespace-folded to one line by the URL parser. */
  text: z
    .string()
    .trim()
    .min(1)
    .max(TEXT_CAPTURE_MAX_LENGTH)
    .regex(/^[^\r\n]+$/, 'must be a single line'),
  /** When the link fired, ISO-8601 — decides the daily note it lands on. */
  capturedAt: z.iso.datetime({ offset: true }),
  /** Where the capture came from. */
  source: textCaptureSourceSchema,
})

export type TextCaptureEnvelope = z.infer<typeof textCaptureEnvelopeSchema>
export type TextCaptureKind = z.infer<typeof textCaptureKindSchema>
export type TextCaptureSource = z.infer<typeof textCaptureSourceSchema>

/**
 * Anything the capture inbox can legally hold: a link capture from the
 * browser extension, or a text capture. Dispatch is by **shape** — the
 * `kind` discriminator text envelopes carry and link envelopes lack (they
 * predate it on the wire) — never by `source`, which names provenance and
 * widens independently of shape. Text envelopes parse first so `kind` is
 * honored before the link shape gets a say.
 */
export const inboxEnvelopeSchema = z.union([textCaptureEnvelopeSchema, captureEnvelopeSchema])

export type InboxEnvelope = z.infer<typeof inboxEnvelopeSchema>

/**
 * The host's reply to the extension. `queued` is the only success state the
 * host can honestly claim — it spools and exits, and never observes the
 * desktop app draining the inbox.
 */
export const captureAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: z.literal('queued') }),
  z.object({
    ok: z.literal(false),
    /**
     * `no-graph`: no pointer file — the app has never opened a graph.
     * `invalid-payload`: the wire message failed validation.
     * `io`: the spool write failed.
     */
    code: z.enum(['no-graph', 'invalid-payload', 'io']),
    message: z.string(),
  }),
])

export type CaptureAck = z.infer<typeof captureAckSchema>
