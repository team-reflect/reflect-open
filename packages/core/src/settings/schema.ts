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
 * The app color theme. `system` (the default) follows the OS preference;
 * `light`/`dark` pin it. Persisted here so the choice survives relaunch.
 */
export const themePreferenceSchema = z.enum(['system', 'light', 'dark']).catch('system')

export type ThemePreference = z.infer<typeof themePreferenceSchema>

export const settingsSchema = z
  .object({
    editorMarkdownSyntax: editorMarkdownSyntaxSchema,
    theme: themePreferenceSchema,
  })
  .passthrough()

export type Settings = z.infer<typeof settingsSchema>

/** The settings a fresh install starts from (every key at its default). */
export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({})
