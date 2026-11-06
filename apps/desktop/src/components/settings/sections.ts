/**
 * The canonical, ordered registry of settings page sections. The section
 * cards and the sticky navigator both render from this list, so the
 * navigator's labels and jump targets can never drift from the page itself.
 */
export const SETTINGS_SECTIONS = [
  // iOS only (the iPad's desktop settings) — the graph's storage and the
  // switcher between the iCloud Drive and on-device graphs.
  { id: 'graph', title: 'Graph' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'editor', title: 'Editor' },
  { id: 'date-time', title: 'Date & time' },
  { id: 'templates', title: 'Note templates' },
  { id: 'all-notes', title: 'All notes' },
  { id: 'search', title: 'Search' },
  { id: 'ai-providers', title: 'AI providers' },
  { id: 'audio-memos', title: 'Audio memos' },
  { id: 'ai-chat', title: 'AI chat' },
  { id: 'ai-prompts', title: 'AI prompts' },
  // macOS only — installs files under ~/.agents for terminal coding agents.
  { id: 'agents', title: 'Agents' },
  // Only shown where the OS frameworks exist — see use-visible-settings-sections.
  { id: 'integrations', title: 'Integrations' },
  { id: 'sync', title: 'Sync' },
  { id: 'accounts', title: 'Accounts' },
  // Not on iOS: the V1 importer reads the export zip from a filesystem path.
  { id: 'import', title: 'Import' },
  // iOS only — the plan and the App Store's restore, manage and redeem controls.
  { id: 'subscription', title: 'Subscription' },
  { id: 'about', title: 'About' },
  // Not on iOS, whose graphs live in fixed roots the Graph section switches between.
  { id: 'destructive', title: 'Danger zone' },
] as const

/** Identifier of one {@link SETTINGS_SECTIONS} entry. */
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

/** The heading a section renders — shared by its card and the navigator. */
export function settingsSectionTitle(id: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find((section) => section.id === id)?.title ?? id
}

/** The DOM id a section card carries (prefixed to keep document ids unique). */
export function settingsSectionDomId(id: SettingsSectionId): string {
  return `settings-${id}`
}
