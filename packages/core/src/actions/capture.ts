import { z } from 'zod'
import { errorMessage, isAppError, toAppError } from '../errors'
import { describePage, isDescriptionRejected } from '../ai/describe-page'
import { defaultAiProvider, type AiProvidersState } from '../ai/provider-config'
import { aiKeySecretName } from '../ai/secrets'
import {
  captureInboxList,
  captureInboxRead,
  captureInboxReject,
  captureInboxRemove,
  listFiles,
  promoteCaptureScreenshot,
  readAsset,
  readNote,
  writeNote,
} from '../graph/commands'
import { assetPath, dailyPath, notePath } from '../graph/paths'
import { hashContent } from '../indexing/hash'
import { appendUnderHeading } from '../markdown/edit'
import { parseNote } from '../markdown/extract'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import type { Frontmatter } from '../markdown/model'
import { getSecret } from '../secrets/keychain'
import { captureEnvelopeSchema, type CaptureEnvelope } from './capture-envelope'
import { scrapePageMeta, type PageMeta } from './meta-scrape'
import type { ReconcileStop } from './audio-memo'

/**
 * Link capture (Plan 11), the second of the `actions/` capture family — the
 * same raw-first shape as audio memos: the spooled envelope is drained into a
 * durable **raw** save (a dedicated capture note + a `[[Links]]` entry in the
 * capture-day daily note), and enrichment (meta scrape + BYOK AI description)
 * runs later, patching the note in place and retrying freely.
 *
 * 1. **Drain** ({@link drainCaptureInbox}): every `.json` envelope the
 *    native-messaging host spooled into `.reflect/inbox/` becomes
 *    `notes/capture-<stamp>.md` (provenance in frontmatter, screenshot
 *    promoted into `assets/`) plus a `[[capture-…|Title]]` line under the
 *    daily note's `## Links` heading. Identity derives from `capturedAt`, so
 *    a crashed drain re-runs idempotently; the spool files are removed last.
 *    Re-capturing the same URL on the same day with the same selection
 *    refreshes the existing note in place instead of duplicating the entry.
 * 2. **Enrich** ({@link reconcileCaptureEnrichment}): every capture note with
 *    `captureStatus: pending` gets the page's meta tags (scraped through the
 *    hard-capped Rust fetch) and — when a provider is configured — an AI
 *    description grounded in the screenshot, inserted under the link line.
 *    A note the user edited (the body hash no longer matches) or made
 *    private is skipped, never clobbered.
 *
 * Privacy: a capture whose daily note is `private: true` is saved raw with
 * `captureStatus: skipped` — no meta fetch, no provider call, ever. The
 * enrichment pass re-checks both the capture note's and the daily note's
 * flags live before any outbound traffic.
 */

/** Where the daily-note entry lands (`appendUnderHeading` creates it). */
const LINKS_HEADING = 'Links'

/** Long-edge cap for promoted screenshots (the Rust side re-encodes JPEG). */
const SCREENSHOT_MAX_DIM = 1600

/** Spool `.jpg`s with no sibling `.json` older than this are host-crash debris. */
const ORPHAN_SPOOL_MAX_AGE_MS = 60 * 60 * 1000

const INBOX_PREFIX = '.reflect/inbox/'

/** Is this watcher path a spooled capture envelope? (The drain trigger.) */
export function isCaptureSpoolPath(path: string): boolean {
  return path.startsWith(INBOX_PREFIX) && path.endsWith('.json')
}

// ---- identity -----------------------------------------------------------------

/** Everything derivable from a capture's timestamped base name. */
export interface CaptureIdentity {
  /** `capture-2026-06-12-153022-845` — note filename, alias, asset stem. */
  base: string
  /** Local ISO day of the capture — the daily note that links it. */
  date: string
  /** Graph-relative path of the capture note, `notes/<base>.md`. */
  notePath: string
  /** Graph-relative path of the promoted screenshot, `assets/<base>.jpg`. */
  assetPath: string
}

const CAPTURE_PATH_RE =
  /^notes\/(capture-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})-\d{3}-[0-9a-f]{4})\.md$/

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function buildIdentity(base: string, date: string): CaptureIdentity {
  return {
    base,
    date,
    notePath: notePath(base),
    assetPath: assetPath(`${base}.jpg`),
  }
}

/**
 * The identity a capture stores under — **local-time** components of
 * `capturedAt` (the audio-memo convention, so the daily note matches the day
 * the user experienced) plus a slice of the envelope's UUID. Deterministic
 * per envelope, which makes a crashed drain's re-run overwrite its own
 * partial work instead of duplicating it; the id slice keeps two *different*
 * envelopes stamped in the same millisecond (two windows' popups saving at
 * once) from colliding onto one note path.
 */
export function captureIdentity(capturedAt: Date, envelopeId: string): CaptureIdentity {
  const date = `${capturedAt.getFullYear()}-${pad(capturedAt.getMonth() + 1, 2)}-${pad(capturedAt.getDate(), 2)}`
  const stamp = `${pad(capturedAt.getHours(), 2)}${pad(capturedAt.getMinutes(), 2)}${pad(capturedAt.getSeconds(), 2)}`
  const suffix = envelopeId.slice(0, 4).toLowerCase()
  const base = `capture-${date}-${stamp}-${pad(capturedAt.getMilliseconds(), 3)}-${suffix}`
  return buildIdentity(base, date)
}

/**
 * Recover a capture's identity from its note path, or `null` for anything
 * that isn't a well-formed capture note — enrichment must never touch
 * arbitrary user notes.
 */
export function captureFromPath(path: string): CaptureIdentity | null {
  const match = CAPTURE_PATH_RE.exec(path)
  if (match === null) {
    return null
  }
  const [, base, date, hours, minutes, seconds] = match
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
    return null
  }
  try {
    dailyPath(date) // calendar-validates like the daily link will
  } catch {
    return null
  }
  return buildIdentity(base, date)
}

// ---- the capture note -----------------------------------------------------------

/** Enrichment lifecycle of a capture note, in its frontmatter. */
export type CaptureStatus = 'pending' | 'done' | 'skipped'

/**
 * The capture-owned frontmatter keys. Parsed from the tolerant frontmatter
 * passthrough — a note that doesn't carry these (or carries mangled ones)
 * simply isn't treated as a capture.
 */
const captureNoteMetaSchema = z.object({
  captureUrl: z.string(),
  captureStatus: z.enum(['pending', 'done', 'skipped']),
  captureHash: z.string(),
  captureSelectionHash: z.string().optional(),
  captureScreenshot: z.string().optional(),
})

export type CaptureNoteMeta = z.infer<typeof captureNoteMetaSchema>

/** The capture keys from a parsed frontmatter, or `null` when absent/mangled. */
export function captureNoteMeta(frontmatter: Frontmatter): CaptureNoteMeta | null {
  const parsed = captureNoteMetaSchema.safeParse(frontmatter)
  return parsed.success ? parsed.data : null
}

/** `[[…]]` has no escaping — strip the characters that would corrupt a link. */
function wikiLinkSafe(text: string): string {
  return text.replace(/[[\]|\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
}

function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The capture's display title: the page title, else the URL's host. */
function displayTitle(envelope: CaptureEnvelope): string {
  const title = wikiLinkSafe(envelope.title)
  return title !== '' ? title : urlHost(envelope.url)
}

/** The raw note body — phase 1's durable content, hashed for the edit guard. */
function captureNoteBody(
  envelope: CaptureEnvelope,
  identity: CaptureIdentity,
  hasScreenshot: boolean,
): string {
  const title = displayTitle(envelope)
  const parts = [`# ${title}`, `[${urlHost(envelope.url)}](${envelope.url})`]
  const note = envelope.note?.trim()
  if (note) {
    parts.push(note)
  }
  const selection = envelope.selection?.trim()
  if (selection) {
    parts.push(
      selection
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
    )
  }
  if (hasScreenshot) {
    parts.push(`![${title}](${identity.assetPath})`)
  }
  return `${parts.join('\n\n')}\n`
}

async function captureNoteSource(
  envelope: CaptureEnvelope,
  identity: CaptureIdentity,
  options: { hasScreenshot: boolean; status: CaptureStatus; selectionHash?: string },
): Promise<string> {
  const body = captureNoteBody(envelope, identity, options.hasScreenshot)
  return upsertFrontmatter(body, {
    aliases: [identity.base],
    captureUrl: envelope.url,
    capturedAt: envelope.capturedAt,
    captureSource: envelope.source,
    captureStatus: options.status,
    captureHash: await hashContent(body),
    captureSelectionHash: options.selectionHash,
    captureScreenshot: options.hasScreenshot ? identity.assetPath : undefined,
  })
}

// ---- shared reads ---------------------------------------------------------------

/** A note's source at `generation`, where "no note yet" reads as empty. */
async function noteSource(path: string, generation: number): Promise<string> {
  try {
    return await readNote(path, generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return ''
    }
    throw cause
  }
}

function notePrivate(source: string): boolean {
  return parseFrontmatter(splitFrontmatter(source).raw).data.private
}

// ---- drain ----------------------------------------------------------------------

export interface DrainCaptureInboxInput {
  /** `GraphInfo.generation` — pins every read and write to the issuing graph. */
  generation: number
  /** Abort gate, checked between spool files (graph switch / unmount). */
  isStale?: () => boolean
  /** Clock for the orphan sweep; injectable for tests. */
  now?: () => number
}

export interface DrainCaptureInboxOutcome {
  /** Spooled envelopes present when the pass started. */
  pending: number
  /** Captures written (fresh notes plus dedup refreshes). */
  drained: number
  /** Of `drained`, how many refreshed an existing same-day entry in place. */
  deduped: number
  /** Unparseable spool files quarantined under `.reflect/inbox-rejected/`. */
  invalid: number
  /** Why spool files remain, or `null` when the inbox drained. */
  stopped: ReconcileStop | null
}

/**
 * Find a same-day capture of `url` with the same selection in the daily
 * note's `## Links` section — the dedup rule: such a re-capture refreshes
 * the existing note instead of adding a second entry. A different day, a
 * different selection, or no prior entry returns `null` (a fresh capture).
 */
async function findSameDayCapture(
  dailySource: string,
  url: string,
  selectionHash: string | undefined,
  generation: number,
): Promise<CaptureIdentity | null> {
  const { headings, wikiLinks } = parseNote({ path: '', source: dailySource })
  const links = headings.find((heading) => heading.text.toLowerCase() === LINKS_HEADING.toLowerCase())
  if (!links) {
    return null
  }
  const sectionEnd =
    headings.find((heading) => heading.from > links.from && heading.level <= links.level)?.from ??
    dailySource.length
  const targets = wikiLinks
    .filter((link) => link.from >= links.to && link.from < sectionEnd)
    .map((link) => link.target)
  for (const target of targets) {
    const identity = captureFromPath(notePath(target))
    if (identity === null) {
      continue
    }
    let source: string
    try {
      source = await readNote(identity.notePath, generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        continue
      }
      throw cause
    }
    const meta = captureNoteMeta(parseFrontmatter(splitFrontmatter(source).raw).data)
    if (meta && meta.captureUrl === url && meta.captureSelectionHash === selectionHash) {
      return identity
    }
  }
  return null
}

/** Strip the inbox prefix off a spool listing path. */
function spoolName(path: string): string {
  return path.startsWith(INBOX_PREFIX) ? path.slice(INBOX_PREFIX.length) : path
}

/**
 * Drain every spooled capture into the graph — phase 1, the durable save.
 * Called on launch (captures that arrived while the app was closed) and on
 * every inbox watcher event. Spool files are removed **last**, so a crash at
 * any point re-runs cleanly (identity is deterministic, the daily append is
 * presence-guarded). Never throws.
 */
export async function drainCaptureInbox(
  input: DrainCaptureInboxInput,
): Promise<DrainCaptureInboxOutcome> {
  let entries
  try {
    entries = await captureInboxList(input.generation)
  } catch (cause) {
    return {
      pending: 0,
      drained: 0,
      deduped: 0,
      invalid: 0,
      stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) },
    }
  }
  const spools = entries
    .filter((entry) => entry.path.endsWith('.json'))
    .sort((first, second) => first.modifiedMs - second.modifiedMs || first.path.localeCompare(second.path))

  let drained = 0
  let deduped = 0
  let invalid = 0
  const stale = (): boolean => input.isStale?.() === true
  const outcome = (stopped: ReconcileStop | null): DrainCaptureInboxOutcome => ({
    pending: spools.length,
    drained,
    deduped,
    invalid,
    stopped,
  })

  for (const spool of spools) {
    if (stale()) {
      return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
    }
    const name = spoolName(spool.path)
    try {
      const raw = await captureInboxRead(name, input.generation)
      const envelope = parseEnvelope(raw)
      if (envelope === null) {
        // An unparseable file must not wedge the queue behind it — but it is
        // quarantined (with its screenshot sibling), never deleted: it may be
        // a capture from a newer extension this app version can't read yet.
        await captureInboxReject(name, input.generation)
        await captureInboxReject(name.replace(/\.json$/, '.jpg'), input.generation)
        invalid += 1
        continue
      }

      const fresh = captureIdentity(new Date(envelope.capturedAt), envelope.id)
      const daily = dailyPath(fresh.date)
      const dailySource = await noteSource(daily, input.generation)
      const selection = envelope.selection?.trim()
      const selectionHash = selection ? await hashContent(selection) : undefined
      // Dedup decides the identity BEFORE any write — a same-day re-capture
      // reuses the existing note's base and asset name, never orphaning a
      // fresh pair.
      const existing = await findSameDayCapture(
        dailySource,
        envelope.url,
        selectionHash,
        input.generation,
      )
      const identity = existing ?? fresh

      // Privacy gate: a private daily note still gets the raw link, but the
      // capture is marked skipped — no enrichment, no outbound traffic, ever.
      const status: CaptureStatus = notePrivate(dailySource) ? 'skipped' : 'pending'

      let hasScreenshot = false
      if (envelope.screenshotRef) {
        try {
          await promoteCaptureScreenshot(
            envelope.screenshotRef,
            identity.assetPath,
            SCREENSHOT_MAX_DIM,
            input.generation,
          )
          hasScreenshot = true
        } catch (cause) {
          const kind = isAppError(cause) ? cause.kind : null
          if (kind !== 'notFound' && kind !== 'parse') {
            throw cause // io etc. — transient, stop the pass and retry
          }
          // notFound: the sibling never landed. parse: bytes that don't
          // decode as an image — retrying the identical bytes can't help,
          // and stopping would wedge every capture behind this one. Either
          // way, save the capture without its screenshot.
        }
      }

      await writeNote(
        identity.notePath,
        await captureNoteSource(envelope, identity, {
          hasScreenshot,
          status,
          selectionHash,
        }),
        input.generation,
      )
      if (!dailySource.includes(`[[${identity.base}`)) {
        await writeNote(
          daily,
          appendUnderHeading(dailySource, LINKS_HEADING, `[[${identity.base}|${displayTitle(envelope)}]]`),
          input.generation,
        )
      }
      await captureInboxRemove(name, input.generation)
      if (envelope.screenshotRef) {
        await captureInboxRemove(envelope.screenshotRef, input.generation)
      }
      drained += 1
      if (existing !== null) {
        deduped += 1
      }
    } catch (cause) {
      return outcome({ reason: toAppError(cause).kind, message: errorMessage(cause) })
    }
  }

  try {
    await sweepOrphanSpools(entries, input)
  } catch (cause) {
    return outcome({ reason: toAppError(cause).kind, message: errorMessage(cause) })
  }
  return outcome(null)
}

function parseEnvelope(raw: string): CaptureEnvelope | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = captureEnvelopeSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/**
 * A host crash between its two spool writes leaves a `.jpg` with no `.json`
 * commit. Old enough ones (the age guard covers a host writing right now)
 * are debris — remove them so the inbox can't accrete junk.
 */
async function sweepOrphanSpools(
  entries: Array<{ path: string; modifiedMs: number }>,
  input: DrainCaptureInboxInput,
): Promise<void> {
  const now = input.now ?? Date.now
  const jsonStems = new Set(
    entries
      .filter((entry) => entry.path.endsWith('.json'))
      .map((entry) => entry.path.replace(/\.json$/, '')),
  )
  const orphans = entries.filter(
    (entry) =>
      entry.path.endsWith('.jpg') &&
      !jsonStems.has(entry.path.replace(/\.jpg$/, '')) &&
      now() - entry.modifiedMs > ORPHAN_SPOOL_MAX_AGE_MS,
  )
  for (const orphan of orphans) {
    await captureInboxRemove(spoolName(orphan.path), input.generation)
  }
}

// ---- enrichment ------------------------------------------------------------------

/**
 * Capture notes still awaiting enrichment, oldest first: well-formed capture
 * notes whose frontmatter says `captureStatus: pending`. Pending state lives
 * in the note itself — it survives restarts and needs no side queue.
 */
export async function listPendingCaptures(generation: number): Promise<CaptureIdentity[]> {
  const files = await listFiles(generation)
  const candidates = files
    .map((file) => captureFromPath(file.path))
    .filter((identity): identity is CaptureIdentity => identity !== null)
    .sort((first, second) => first.base.localeCompare(second.base))
  const pending: CaptureIdentity[] = []
  for (const identity of candidates) {
    let source: string
    try {
      source = await readNote(identity.notePath, generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        continue
      }
      throw cause
    }
    const meta = captureNoteMeta(parseFrontmatter(splitFrontmatter(source).raw).data)
    if (meta?.captureStatus === 'pending') {
      pending.push(identity)
    }
  }
  return pending
}

export interface ReconcileCaptureEnrichmentInput {
  /** The configured-providers state — decides the provider and keychain entry. */
  providers: AiProvidersState
  /** `GraphInfo.generation` — pins every read and write to the issuing graph. */
  generation: number
  /** Transport for the provider call (the Tauri HTTP plugin's fetch). */
  fetchFn?: typeof fetch
  /** Abort gate, checked between notes and after every slow await. */
  isStale?: () => boolean
  /** Observes how many captures need enrichment, before work starts. */
  onPending?: (count: number) => void
}

export interface ReconcileCaptureEnrichmentOutcome {
  /** Captures that were pending when the pass started. */
  pending: number
  /** Captures this pass enriched (meta tags, plus AI when configured). */
  enriched: number
  /** Captures marked skipped (made private, or edited since the raw save). */
  skipped: number
  /** Why captures remain pending, or `null` when the pass drained. */
  stopped: ReconcileStop | null
}

/**
 * Insert the description paragraph directly under the capture's link line.
 * The body is hash-verified raw output of {@link captureNoteBody}, so the
 * anchor is always present; the append fallback only guards the impossible.
 */
function withDescription(body: string, url: string, description: string): string {
  const anchor = body.indexOf(`](${url})`)
  if (anchor === -1) {
    return `${body.replace(/\s*$/, '')}\n\n${description}\n`
  }
  const lineEnd = body.indexOf('\n', anchor)
  const insertAt = lineEnd === -1 ? body.length : lineEnd
  return `${body.slice(0, insertAt)}\n\n${description}${body.slice(insertAt)}`
}

/**
 * Enrich every pending capture: scrape the page's meta tags, generate the AI
 * description (when a provider is configured — the screenshot, title, URL,
 * and scraped meta ground it), insert the description under the link line,
 * and stamp provenance + `captureStatus: done`. Both privacy flags are
 * re-checked live before any outbound call; an edited body (hash mismatch)
 * is skipped, never clobbered. Transient failures (offline, auth) stop the
 * pass for the next trigger to retry; a provider refusing one capture falls
 * back to the scraped description. Never throws.
 */
export async function reconcileCaptureEnrichment(
  input: ReconcileCaptureEnrichmentInput,
): Promise<ReconcileCaptureEnrichmentOutcome> {
  let pending: CaptureIdentity[]
  try {
    pending = await listPendingCaptures(input.generation)
  } catch (cause) {
    return {
      pending: 0,
      enriched: 0,
      skipped: 0,
      stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) },
    }
  }
  input.onPending?.(pending.length)
  if (pending.length === 0) {
    return { pending: 0, enriched: 0, skipped: 0, stopped: null }
  }

  // Re-picked every pass: a provider added in Settings mid-session must be
  // seen by the very next pass. No provider at all still enriches with meta
  // tags; a configured provider whose key vanished from the keychain stops
  // the pass instead — enriching "done" without the AI half would silently
  // strand those captures un-described forever.
  const config = defaultAiProvider(input.providers)
  let apiKey: string | null = null
  if (config !== null) {
    apiKey = await getSecret(aiKeySecretName(config.id)).catch(() => null)
    if (apiKey === null) {
      return {
        pending: pending.length,
        enriched: 0,
        skipped: 0,
        stopped: {
          reason: 'config',
          message: `The API key for the configured ${config.provider} model is missing from the keychain.`,
        },
      }
    }
  }

  let enriched = 0
  let skipped = 0
  const stale = (): boolean => input.isStale?.() === true
  const outcome = (stopped: ReconcileStop | null): ReconcileCaptureEnrichmentOutcome => ({
    pending: pending.length,
    enriched,
    skipped,
    stopped,
  })
  const markSkipped = async (source: string, identity: CaptureIdentity): Promise<void> => {
    await writeNote(
      identity.notePath,
      upsertFrontmatter(source, { captureStatus: 'skipped' }),
      input.generation,
    )
    skipped += 1
  }

  for (const identity of pending) {
    if (stale()) {
      return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
    }
    try {
      let source: string
      try {
        source = await readNote(identity.notePath, input.generation)
      } catch (cause) {
        if (isAppError(cause) && cause.kind === 'notFound') {
          continue // removed since the listing — nothing to enrich
        }
        throw cause
      }
      const split = splitFrontmatter(source)
      const frontmatter = parseFrontmatter(split.raw).data
      const meta = captureNoteMeta(frontmatter)
      if (meta === null || meta.captureStatus !== 'pending') {
        continue
      }

      // Privacy, re-checked live on BOTH flags: the capture note's own, and
      // the capture-day daily note's (the likely app-closed sequence is
      // "drain, mark the day private, relaunch").
      const dailySource = await noteSource(dailyPath(identity.date), input.generation)
      if (frontmatter.private || notePrivate(dailySource)) {
        await markSkipped(source, identity)
        continue
      }

      // Edit guard: the body must still be exactly what the drain wrote.
      if ((await hashContent(split.body)) !== meta.captureHash) {
        await markSkipped(source, identity)
        continue
      }

      let pageMeta: PageMeta | null = null
      try {
        pageMeta = await scrapePageMeta(meta.captureUrl)
      } catch (cause) {
        const kind = toAppError(cause).kind
        if (kind === 'network' || kind === 'auth') {
          throw cause // transient — stop the pass, retry on the next trigger
        }
        pageMeta = null // permanent (404, not HTML) — enrich without it
      }
      if (stale()) {
        return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
      }

      let description: string | null = null
      if (config !== null && apiKey !== null) {
        let screenshotBase64: string | undefined
        if (meta.captureScreenshot) {
          try {
            screenshotBase64 = await readAsset(meta.captureScreenshot, input.generation)
          } catch (cause) {
            if (!isAppError(cause) || cause.kind !== 'notFound') {
              throw cause
            }
          }
        }
        try {
          description = await describePage({
            config,
            apiKey,
            fetchFn: input.fetchFn,
            url: meta.captureUrl,
            title: parseNote({ path: identity.notePath, source }).title,
            metaDescription: pageMeta?.description ?? undefined,
            screenshotBase64,
          })
        } catch (cause) {
          if (!isDescriptionRejected(cause)) {
            throw cause
          }
          description = null // the provider refused this capture — meta only
        }
        if (stale()) {
          return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
        }
      }

      const text = description ?? pageMeta?.description ?? null
      const newBody = text !== null ? withDescription(split.body, meta.captureUrl, text) : split.body
      const reassembled = source.slice(0, split.bodyOffset) + newBody
      const usedAi = description !== null && config !== null
      await writeNote(
        identity.notePath,
        upsertFrontmatter(reassembled, {
          captureStatus: 'done' satisfies CaptureStatus,
          captureHash: await hashContent(newBody),
          captureProvider: usedAi ? config.provider : undefined,
          captureModel: usedAi ? config.model : undefined,
        }),
        input.generation,
      )
      enriched += 1
    } catch (cause) {
      return outcome({ reason: toAppError(cause).kind, message: errorMessage(cause) })
    }
  }
  return outcome(null)
}
