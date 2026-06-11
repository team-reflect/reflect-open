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
 * How the editor renders markdown syntax characters. `focus` (the default)
 * hides them except near the caret; `show` always displays them.
 *
 * The persisted name is implementation-neutral on purpose — it maps to
 * meowdown's "mark mode" at the editor boundary, but the settings document
 * must outlive any one editor library.
 */
export const editorMarkdownSyntaxSchema = z.enum(['focus', 'show']).catch('focus')

export type EditorMarkdownSyntax = z.infer<typeof editorMarkdownSyntaxSchema>

/**
 * Whether the editor underlines misspelled words (the platform's native
 * spell check on the contenteditable). On by default — turning it off is the
 * preference of users who find the underlines noisy in note-taking.
 */
export const editorSpellCheckSchema = z.boolean().catch(true)

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
 * How calendar dates are ordered when displayed throughout the app:
 * `mdy` (the default) renders `June 10th, 2026`; `dmy` renders
 * `10th June 2026`. Display-only — daily-note filenames and stored dates
 * stay ISO `YYYY-MM-DD` regardless.
 */
export const dateFormatSchema = z.enum(['mdy', 'dmy']).catch('mdy')

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
 * One configured AI model: a provider and the chosen model id. The API key
 * itself lives in the OS keychain (addressed by `id` — see `aiKeySecretName`)
 * and **never** in this document; `keyHint` keeps only the key's trailing
 * characters so the settings UI can identify it. Which entry is the app-wide
 * default is a sibling scalar (`defaultAiModelId`), not a per-entry flag, so
 * "at most one default" holds by construction.
 */
export const aiModelConfigSchema = z.object({
  id: z.string().min(1),
  provider: aiProviderIdSchema,
  model: z.string().min(1),
  keyHint: z.string().catch(''),
})

export type AiModelConfig = z.infer<typeof aiModelConfigSchema>

/**
 * The `aiModels` entry AI features use by default. A dangling or null id is
 * legal (hand-edits, removed entries) — readers resolve it through
 * `defaultAiModel`, which falls back to the first entry.
 */
export const defaultAiModelIdSchema = z.string().nullable().catch(null)

/**
 * The configured AI models. Resilience is per entry, not per list: a corrupt
 * entry is dropped while the rest load, so one bad hand-edit can't wipe every
 * configured provider. A non-array value degrades to the empty list.
 */
export const aiModelsSchema = z
  .array(z.unknown())
  .catch([])
  .transform((entries) =>
    entries.flatMap((entry) => {
      const parsed = aiModelConfigSchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    }),
  )

export const settingsSchema = z
  .object({
    editorMarkdownSyntax: editorMarkdownSyntaxSchema,
    editorSpellCheck: editorSpellCheckSchema,
    semanticSearchEnabled: semanticSearchEnabledSchema,
    theme: themePreferenceSchema,
    timeFormat: timeFormatSchema,
    dateFormat: dateFormatSchema,
    weekStartDay: weekStartDaySchema,
    allNotesFilterTags: allNotesFilterTagsSchema,
    graphColors: graphColorsSchema,
    aiModels: aiModelsSchema,
    defaultAiModelId: defaultAiModelIdSchema,
  })
  .passthrough()

export type Settings = z.infer<typeof settingsSchema>

/** The settings a fresh install starts from (every key at its default). */
export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({})
