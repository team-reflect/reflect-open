# UI Parity Pass — Plan

Branch: `ui/reflect-parity-pass-20260609-2232` · Base: `origin/master` @ `4fe1dc8`

Goal: bring Reflect Open's shell, settings, keyboard-shortcut discoverability,
icons, and interaction polish up to the UX bar set by the original Reflect app
(`/Users/cloud/repos/team-reflect/reflect`, read-only reference), translated
into this repo's React/Vite/Tauri + design-system architecture — not copied.

## 1. What the original app does right (source observations)

Sidebar / shell (`client/screens/main/main.tsx`,
`client/screens/main/notes-sidebar/notes-sidebar.tsx`,
`client/screens/main/notes-sidebar/menu.tsx`,
`client/screens/main/notes-sidebar/account-nav/account-nav.tsx`):

- Three-region layout: a ~300px left sidebar on a sunken background
  (`bg-coolgray-50 dark:bg-gray-800/30`), the editor as the bright hero
  surface, an optional right context panel. No top header bar — chrome lives
  in the sidebar, prose is edge-to-edge.
- Sidebar anatomy, top to bottom: search field ("Search anything…" with a ⌘K
  keycap), primary nav (Daily Notes / All Notes / Tasks / Map) with icons and
  per-item shortcut keycaps revealed on hover, pinned notes section with a
  `text-xs font-medium text-coolgray-400` heading, a flex spacer, and an
  account/graph footer (colored graph dot + graph name dropdown: preferences
  `Mod+,`, billing, sign out).
- Item treatment (`menu.tsx`, `components/sidebar-item/sidebar-item.tsx`):
  `px-2.5 py-1.5 rounded-md text-sm font-medium`, hover `bg-gray-200/50
  dark:bg-white/3`, active `text-primary` on the same wash. Quiet, dense,
  keyboard-annotated.

Settings (`client/screens/preferences/preferences.tsx`,
`preferences-sidebar/menu.tsx`, `preferences-profile/preferences-profile.tsx`,
`preferences-profile/theme-picker.tsx`):

- A routed preferences surface with grouped categories, `Mod+,` to open,
  Escape to leave.
- Page pattern: `text-xl font-medium` section title, then label/control rows
  on a grid with `border-t` hairline dividers between rows; controls are
  real primitives (switch, select, text input) with purple focus rings.
- Theme picker is three radio cards (System / Dark / Light) with a preview
  and a `ring-brand` selected state — appearance is a first-class setting.

Keyboard shortcuts (`lib/keyboard-shortcut.ts`, `lib/use-hotkeys.ts`,
`components/shortcuts.tsx`, `components/shortcut-text.tsx`,
`client/screens/main/shortcuts/shortcuts-modal.tsx`):

- One formatter renders any binding as keycaps: ⌘ ⌥ ⌃ ⇧ ↩ symbols on macOS,
  text ("Ctrl") elsewhere. Keycap style: `rounded-md border border-coolgray-300
  bg-white px-1 py-0.5 text-[10px] font-semibold shadow-sm`.
- Shortcuts are *visible everywhere*: search field, sidebar items on hover,
  menu rows, tooltips, and a filterable cheat-sheet modal grouped into
  Core / Navigation / Editing.

Icons (`components/icons/*.tsx`): one consistent set — 24×24 viewBox,
1.5px stroke or `currentColor` fill, sized 16–20px in chrome. No mixed sets.

Polish (`components/ui/*`, `tailwind.config.js`): gentle radii (6–12px),
hairline borders doing the elevation work, `shadow-app-input` on inputs,
focus-visible rings, 150–200ms transitions, z-index discipline.

## 2. Reflect Open gaps (file references)

- `apps/desktop/src/components/app-shell.tsx` — the "rail" is a 56px strip
  rendering a literal `R`; the right sidebar is a hardcoded "Context"
  placeholder burning 320px. No navigation surface exists at all.
- `apps/desktop/src/components/graph-workspace.tsx` — a utility header (graph
  name, "Indexing…", version, a text "Dark mode" button, a gear) is the only
  chrome; the original has no header at all and spends that attention on the
  sidebar.
- `apps/desktop/src/components/settings-screen.tsx` — one section (markdown
  syntax). No appearance section; the theme toggle is header-only and **not
  persisted** (`providers/theme-provider.tsx` keeps it in component state, so
  every launch resets to system).
- Shortcuts exist but are invisible: `routing/app-shortcuts.ts` +
  `lib/commands/app-commands.ts` define Mod-d/n/k/[/]/, and
  `editor/keymap.ts` defines Mod-b/i/e/1/2/3, yet no surface renders a
  keycap, lists bindings, or hints that ⌘K exists. `keymap.ts` even notes
  `listRegisteredBindings()` is "for a future shortcuts UI".
- `components/command-palette/command-palette.tsx` — functional but bare:
  no icons, no keybinding hints on command rows, no ↑↓/↩/esc footer.
- Icons: lucide-react is installed but used exactly once (`Settings` in the
  header). Everything else is text.
- Interaction details: almost no focus-visible treatment, ad-hoc
  `border-black/10` instead of the design-system `--border`/`--surface-*`
  tokens in several places, no hover affordances on header buttons.
- `components/graph-chooser.tsx` — first-run screen is unstyled relative to
  the DS (plain button, no focus rings, no brand treatment).

## 3. Selected scope (this PR)

A coherent "shell + discoverability" slice, all translated to design-system
tokens (`design-system/tokens/*.css` are already imported as CSS variables):

1. **Real sidebar** (`components/sidebar/`): search affordance with ⌘K keycap
   (opens the palette), primary nav (Today `⌘D`, New note `⌘N`,
   Settings `⌘,`) with lucide icons + shortcut keycaps on hover, a
   **Recents** section fed by the existing index
   (`suggestWikiTargets('')` — same recall feed the palette uses), and a
   graph footer (colored graph dot + name + indexing state) opening a menu to
   switch to a recent graph or open another folder (`openRecent`/`pickAndOpen`
   already support this). Collapsible via a new `sidebar.toggle` command
   (`Mod-\`), state owned by the workspace.
2. **Shell rework**: kill the header; the cloud-sync warning banner stays at
   the top of the content column. `AppShell` gets `nav` (left sidebar) +
   `context` (right, unused for now — Plan 10's copilot slot) and stops
   rendering the placeholder. Version moves to Settings → About; theme
   control moves to Settings → Appearance (the `theme.toggle` palette command
   remains).
3. **Shortcut display system**: `lib/keybindings.ts` (pure formatter:
   `Mod-d` → `⌘ D` on Apple, `Ctrl D` elsewhere; `Shift` → ⇧, arrows, ↩) +
   `components/shortcut-keys.tsx` keycap renderer styled like the original.
   Used in: sidebar items, search affordance, palette command rows, palette
   footer, and Settings → Keyboard.
4. **Settings screen**: sectioned layout in the original's idiom (section
   title, hairline-divided label/control rows, radio cards):
   - **Appearance** — System / Light / Dark radio cards; persisted via a new
     `theme` key in the core settings schema (`packages/core/src/settings/schema.ts`),
     with `ThemeProvider` re-seated under `SettingsProvider` so settings are
     the single source of truth.
   - **Editor** — existing markdown-syntax radio cards restyled.
   - **Keyboard** — grouped cheat sheet (Navigation / Editing) rendered from
     the real registries (`APP_COMMANDS` keybindings + editor binding
     descriptions exported alongside `EDITOR_BINDINGS`), so it can never
     drift from the actual bindings.
   - **About** — app version (the hook already exists).
5. **Palette polish**: per-command icons (UI-side map, command registry stays
   React-free), keybinding keycaps on command rows, note/daily icons, and a
   hint footer (↑↓ navigate · ↩ open · esc close).
6. **Interaction pass**: global `:focus-visible` ring (DS `--focus-ring`),
   sidebar/palette hover washes via `--surface-hover`, DS border/surface
   tokens replacing ad-hoc `black/10` in touched components, graph-chooser
   restyle (brand button, hover/focus states, recents list rows).

## 4. Rejected / deferred (parity backlog)

Documented for follow-up in `final-report.md`; deliberately out of scope:

- All Notes / Tasks / Map views and pinned notes (need product surfaces &
  core support — pins don't exist in the schema yet).
- Right context sidebar content (calendar, note actions, suggested
  backlinks) — Plan 10 owns that region; backlinks/related already render
  under the note.
- Resizable/persisted sidebar width (original's SplitGrid); fixed
  `--sidebar-width` (260px) for now, collapse via `⌘\`.
- Full shortcuts *modal* (the settings cheat sheet covers discoverability
  with one fewer surface; revisit if a modal earns its keep).
- Radix/shadcn tooltip system, toasts, audio recording, templates,
  import/export UI, account/billing — no equivalents yet or out of product
  scope for the open core.
- Mod+Shift bindings (⌘⇧D-style alternates): the app listener deliberately
  rejects modifier soup today; revisit with the next command wave.

## 5. Acceptance criteria

- The workspace renders a real sidebar: search affordance with visible ⌘K
  hint, three nav items with icons, active-route highlight, recents that
  navigate, graph footer that can switch graphs; `⌘\` and the palette
  command collapse/expand it.
- No top header; nothing regresses: cloud warning still shows, indexing state
  still visible (sidebar footer), version still findable (Settings → About).
- Settings shows Appearance / Editor / Keyboard / About; picking a theme
  persists across reload (settings JSON), and the keyboard section lists
  every registered app + editor binding with platform keycaps.
- Palette command rows show keycaps; footer hints render; notes/dailies have
  icons.
- All bindings continue to register through `registerKeymap` with no
  collisions (existing test) and `sidebar.toggle` is covered by tests.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` pass at the root.

## 6. Verification plan

- Unit: new `lib/keybindings` formatter tests; sidebar render/interaction
  tests (nav, active state, recents, graph menu, collapse); settings tests
  (theme card persists via `updateSettings`, keyboard list shows real
  bindings, about shows version); palette tests (keycap hints, footer);
  app-shortcuts test for `Mod-\`; core schema test for the `theme` key;
  theme/settings integration test (settings-seeded theme applies `.dark`).
- Repo gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- UI pass: `pnpm tauri dev` against a scratch graph; screenshots of shell +
  sidebar (light/dark), settings, palette. If the native build is blocked,
  fall back to `pnpm dev` (browser) for the chooser/settings-reachable
  surfaces and document the exact blocker.
