import { z } from 'zod'

/**
 * The user-settings schema — the policy half of the settings store. Rust
 * persists an opaque JSON object in the OS config dir; this schema owns the
 * known keys, their defaults, and their validation.
 *
 * Resilience contract (mirrors the frontmatter schema): a missing or invalid
 * value degrades to its default (`.catch`) instead of failing the whole load,
 * and unknown keys are preserved (`.passthrough`) so a document written by a
 * newer app version round-trips through an older one without losing fields.
 */

/**
 * How the editor renders markdown syntax characters. `hide` (the default)
 * hides them, `show` always displays them, and `hybrid` reveals them only
 * around the caret.
 *
 * The persisted name is implementation-neutral on purpose: it maps to
 * meowdown's "mark mode" at the editor boundary (`hybrid` becomes meowdown's
 * `focus`), but the settings document must outlive any one editor library.
 */
export const editorMarkdownSyntaxSchema = z.enum(['hide', 'show', 'hybrid']).catch('hide')

export type EditorMarkdownSyntax = z.infer<typeof editorMarkdownSyntaxSchema>

/**
 * Whether the editor underlines misspelled words (the platform's native
 * spell check on the contenteditable). On by default — turning it off is the
 * preference of users who find the underlines noisy in note-taking.
 */
export const editorSpellCheckSchema = z.boolean().catch(true)

/**
 * Whether a note that opens with an empty body starts the editor on a single
 * empty bullet — old Reflect's every-note default. On by default.
 *
 * The bullet is an **editor affordance only**, never persisted on its own: an
 * empty list item serializes to nothing (`docToMarkdown` drops it), so an
 * unedited note still writes an empty file — and a not-yet-created daily-note
 * placeholder stays uncreated until the first real keystroke (the lazy
 * no-litter contract). The seam lives at the editor (`note-pane.tsx`), not the
 * save pipeline, because seeding the document model with the literal `- `
 * markdown would classify lossy and open the note read-only.
 */
export const editorDefaultBulletSchema = z.boolean().catch(true)

/**
 * Whether pressing Return at the end of a heading starts a new bullet on the
 * next line — old Reflect's "type a title, then bullet" capture flow. On by
 * default.
 *
 * Independent of {@link editorDefaultBulletSchema}: that seeds an empty note's
 * first line, this shapes what Enter *after a heading* produces. They are
 * separate keys so each can be turned off on its own.
 */
export const editorBulletAfterHeadingSchema = z.boolean().catch(true)

/**
 * The editor's reading text size. `small` (the default) is one design-system
 * size down from the prose size (14px); `medium` is the DS prose size (16px)
 * and `large` steps one DS size up (18px). Display-only — it scales the editor
 * body via a CSS variable on the document root (`--editor-font-size`, applied
 * by `EditorTextSizeEffect`) and never touches the stored markdown.
 */
export const editorTextSizeSchema = z.enum(['small', 'medium', 'large']).catch('small')

export type EditorTextSize = z.infer<typeof editorTextSizeSchema>

/**
 * The app color theme. `system` (the default) follows the OS preference;
 * `light`/`dark` pin it. Persisted here so the choice survives relaunch.
 */
export const themePreferenceSchema = z.enum(['system', 'light', 'dark']).catch('system')

export type ThemePreference = z.infer<typeof themePreferenceSchema>

/**
 * How times of day are displayed throughout the app. `12h` (the default)
 * renders `8:22pm`; `24h` renders `20:22`. Display-only — stored timestamps
 * and daily-note keys are unaffected.
 */
export const timeFormatSchema = z.enum(['12h', '24h']).catch('12h')

export type TimeFormat = z.infer<typeof timeFormatSchema>

/**
 * How calendar dates are displayed throughout the app: `mdy` (the default)
 * renders `June 10th, 2026`, `dmy` renders `10th June 2026`, and `iso`
 * renders `2026-06-10`. Display-only — daily-note filenames and stored dates
 * stay ISO `YYYY-MM-DD` regardless.
 */
export const dateFormatSchema = z.enum(['mdy', 'dmy', 'iso']).catch('mdy')

export type DateFormat = z.infer<typeof dateFormatSchema>

/**
 * Which day opens the calendar week. `monday` (the default) follows ISO 8601;
 * `sunday` matches the North-American convention.
 */
export const weekStartDaySchema = z.enum(['monday', 'sunday']).catch('monday')

export type WeekStartDay = z.infer<typeof weekStartDaySchema>

/**
 * Tags pinned as one-click filters on the All Notes screen, in display order.
 * The defaults mirror the original app's built-in filter tabs (book/link/
 * person); the screen offers every other tag through its Custom menu, so an
 * empty list still filters fine. Matching is case-insensitive at the query —
 * entries here keep whatever casing the user typed.
 */
export const allNotesFilterTagsSchema = z.array(z.string()).catch(['book', 'link', 'person'])

export type AllNotesFilterTags = z.infer<typeof allNotesFilterTagsSchema>

/**
 * Whether semantic search is on. Off by default — turning it on downloads the
 * ~90MB embedding model, and that first network fetch is the user's call
 * (Plan 09). Later launches load the cached model because this flag is set.
 */
export const semanticSearchEnabledSchema = z.boolean().catch(false)

/**
 * Whether new eligible images/PDFs added under `assets/` are automatically
 * described by the configured AI provider into a managed `.reflect.md` description
 * (Plan 20). On by default — only new assets, gated to those referenced by
 * public notes; existing assets are never auto-scanned (the Settings backfill
 * action handles those, with a cost warning). Off disables the automatic path
 * entirely.
 */
export const describeAssetsSchema = z.boolean().catch(true)

/**
 * Whether the user has finished the mobile onboarding choice (Plan 19, step
 * 6): "Start fresh" or "Connect to GitHub". Off by default — a fresh install
 * shows the onboarding screen, which (for the GitHub path) clones into the
 * still-empty graph root before anything seeds it. Once set, later launches
 * open the fixed root directly. Mobile-only; desktop has its own chooser, so
 * this key is simply never read there.
 */
export const mobileOnboardedSchema = z.boolean().catch(false)

/**
 * Whether the Apple Contacts integration is on. Off by default — turning it
 * on triggers the OS contacts permission prompt. Lookups are live, on-demand
 * `CNContactStore` queries (attendee resolution, suggested-contact cards);
 * nothing is mirrored into the index and nothing ever leaves the device.
 */
export const contactsEnabledSchema = z.boolean().catch(false)

/**
 * Whether the Apple Calendar integration is on. Off by default — turning it
 * on triggers the macOS calendar-permission prompt, and that is the user's
 * call. Access is read-only and entirely local (EventKit); see
 * docs/porting/calendar-meetings-integration.md.
 */
export const calendarEnabledSchema = z.boolean().catch(false)

/**
 * EventKit identifiers of the calendars whose events appear beside the daily
 * note. Empty (the default) shows nothing — the Settings section lists every
 * calendar on the Mac for opt-in. Identifiers for since-removed accounts are
 * harmless: the Rust side skips ones it can't resolve.
 */
export const calendarIdsSchema = z.array(z.string()).catch([])

export type CalendarIds = z.infer<typeof calendarIdsSchema>

/**
 * The preset palette for a graph's identity color (the swatch shown next to
 * the graph name). A closed set of named ids — not raw hex — so the UI can
 * map each id to values that read well in both light and dark themes.
 */
export const graphColorSchema = z.enum([
  'indigo',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'pink',
  'purple',
])

export type GraphColor = z.infer<typeof graphColorSchema>

/** Every graph color id, in the order pickers should display them. */
export const GRAPH_COLOR_IDS = graphColorSchema.options

export type GraphColors = Record<string, GraphColor>

/**
 * Identity colors the user has chosen per graph, keyed by the graph's absolute
 * root path. An absent key means the default (the app accent). Entries for
 * forgotten graphs are kept on purpose — re-opening that graph later restores
 * its color. Resilience is per entry: a corrupt value is dropped while the
 * rest load, and a non-object value degrades to the empty record.
 */
export const graphColorsSchema = z
  .record(z.string(), z.unknown())
  .catch({})
  .transform((entries) => {
    const colors: GraphColors = {}
    for (const [root, value] of Object.entries(entries)) {
      const parsed = graphColorSchema.safeParse(value)
      if (parsed.success) {
        colors[root] = parsed.data
      }
    }
    return colors
  })

/**
 * The cloud AI providers Reflect can call directly (BYOK — the user's own
 * keys, no Reflect-hosted proxy).
 */
export const aiProviderIdSchema = z.enum(['openai', 'anthropic', 'google'])

export type AiProviderId = z.infer<typeof aiProviderIdSchema>

/**
 * One configured AI provider: the provider, its default model id, and a key
 * hint. The API key itself lives in the OS keychain (addressed by `id` — see
 * `aiKeySecretName`) and **never** in this document; `keyHint` keeps only the
 * key's trailing characters so the settings UI can identify it. Which entry
 * is the app-wide default is a sibling scalar (`defaultAiProviderId`), not a
 * per-entry flag, so "at most one default" holds by construction.
 */
export const aiProviderConfigSchema = z.object({
  id: z.string().min(1),
  provider: aiProviderIdSchema,
  model: z.string().min(1),
  keyHint: z.string().catch(''),
})

export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>

/**
 * The `aiProviders` entry AI features use by default. A dangling or null id
 * is legal (hand-edits, removed entries) — readers resolve it through
 * `defaultAiProvider`, which falls back to the first entry.
 */
export const defaultAiProviderIdSchema = z.string().nullable().catch(null)

/**
 * The model the chat last used: a configured `aiProviders` entry (`configId`)
 * plus a model id within it. Persisted so the next chat session starts on
 * whatever the user picked last; null (the default) means the app default
 * entry and its configured model. A dangling reference is legal (the entry
 * may have been removed since) — readers resolve it through
 * `resolveChatModel`, which falls back to the default entry — and an invalid
 * value degrades to null.
 */
export const chatModelSelectionSchema = z
  .object({
    configId: z.string().min(1),
    modelId: z.string().min(1),
  })
  .nullable()
  .catch(null)

/** A chat model choice — a configured provider entry + a model within it. */
export type ChatModelSelection = NonNullable<z.infer<typeof chatModelSelectionSchema>>

/**
 * The configured AI providers. Resilience is per entry, not per list: a
 * corrupt entry is dropped while the rest load, so one bad hand-edit can't
 * wipe every configured provider. A non-array value degrades to the empty
 * list.
 */
export const aiProvidersSchema = z
  .array(z.unknown())
  .catch([])
  .transform((entries) =>
    entries.flatMap((entry) => {
      const parsed = aiProviderConfigSchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    }),
  )

export const settingsSchema = z
  .looseObject({
    editorMarkdownSyntax: editorMarkdownSyntaxSchema,
    editorSpellCheck: editorSpellCheckSchema,
    editorDefaultBullet: editorDefaultBulletSchema,
    editorBulletAfterHeading: editorBulletAfterHeadingSchema,
    editorTextSize: editorTextSizeSchema,
    semanticSearchEnabled: semanticSearchEnabledSchema,
    describeAssets: describeAssetsSchema,
    contactsEnabled: contactsEnabledSchema,
    mobileOnboarded: mobileOnboardedSchema,
    theme: themePreferenceSchema,
    timeFormat: timeFormatSchema,
    dateFormat: dateFormatSchema,
    weekStartDay: weekStartDaySchema,
    allNotesFilterTags: allNotesFilterTagsSchema,
    calendarEnabled: calendarEnabledSchema,
    calendarIds: calendarIdsSchema,
    graphColors: graphColorsSchema,
    aiProviders: aiProvidersSchema,
    defaultAiProviderId: defaultAiProviderIdSchema,
    chatModelSelection: chatModelSelectionSchema,
  })

export type Settings = z.infer<typeof settingsSchema>

/** The settings a fresh install starts from (every key at its default). */
export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({})
