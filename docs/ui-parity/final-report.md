# UI Parity Pass — Final Report

Branch: `ui/reflect-parity-pass-20260609-2232` · Base: `origin/master` @ `4fe1dc8`
Date: 2026-06-09

## What shipped

A coherent "shell + discoverability" slice bringing Reflect Open's chrome up
to the original Reflect app's UX bar, translated into this repo's
design-system tokens rather than copied. 38 code files changed
(+1,265 / −230) across five commits:

1. `a6b78f9` — Real sidebar, headerless shell, persisted theme, shortcut keycaps
2. `5d91f80` — Settings: Appearance, Editor, Keyboard, and About sections
3. `6cbf754` — Palette polish, global focus ring, graph chooser on DS tokens
4. `b203b00` — Sidebar component tests
5. `048da8d` — Editor CSS fix (found during the screenshot pass) + screenshots

### Sidebar (`apps/desktop/src/components/sidebar/`)

- Search affordance ("Search anything…" + ⌘K keycap) that opens the palette.
- Primary nav — Today `⌘D`, New note `⌘N`, Settings `⌘,` — lucide icons,
  active-route highlight, keycaps revealed on hover/focus, rows executing the
  real command registry (no duplicated handlers).
- **Recents** fed by the same index recall feed the palette uses
  (`suggestWikiTargets('')`); dailies render friendly labels and route via
  the daily route even before their file exists.
- Graph footer: colored graph dot, name, "Indexing…" state; menu switches to
  a recent graph (`openRecent`) or opens another folder (`pickAndOpen`).
- Collapsible: `sidebar.toggle` command bound to `Mod-\`, state owned by
  `providers/sidebar-provider.tsx`, also runnable from the palette.

### Shell (`app-shell.tsx`, `graph-workspace.tsx`)

The utility header is gone — chrome lives in the sidebar like the original.
`AppShell` exposes `nav` + `context` regions (the right region is reserved
for Plan 10's copilot and renders nothing today). Cloud-sync warning stays at
the top of the content column; app version moved to Settings → About;
indexing state moved to the sidebar footer.

### Shortcut display system

- `lib/keybindings.ts`: pure formatter, `Mod-d` → `⌘ D` on Apple platforms,
  `Ctrl D` elsewhere; ⇧ for Shift, arrows, ↩. Unit-tested.
- `components/kbd.tsx` + `components/shortcut-keys.tsx`: keycap renderer in
  the original's idiom (hairline border, sunken bg, 10px semibold).
- Shortcuts are now *visible*: sidebar rows, search affordance, palette
  command rows, palette footer, Settings → Keyboard.

### Settings (`components/settings/`)

Sectioned in the original's pattern (section title, hairline-divided
label/control rows, radio cards):

- **Appearance** — System / Light / Dark radio cards; new `theme` key in the
  core settings schema (`packages/core/src/settings/schema.ts`), so theme
  choice now persists across launches. `ThemeProvider` is re-seated under
  `SettingsProvider`, making settings the single source of truth (the
  `theme.toggle` palette command remains and round-trips through settings).
- **Editor** — existing markdown-syntax choice restyled as radio cards.
- **Keyboard** — cheat sheet (Navigation / Editing) rendered from the live
  registries (`APP_COMMANDS` + `EDITOR_BINDINGS` descriptions), so it cannot
  drift from the actual bindings.
- **About** — app version.

### Command palette

Per-command lucide icons (UI-side map in `command-icons.ts`; the command
registry stays React-free), keycap hints on bound commands, note/daily row
icons, and a footer (↑↓ navigate · ↩ open · esc close).

### Interaction pass

Global zero-specificity `:focus-visible` ring on the DS `--focus-ring` token;
hover washes on `--surface-hover`; ad-hoc `black/10` borders replaced with DS
tokens in touched components; graph chooser restyled (brand button, recents
rows with hover-revealed Forget, focus states).

### Editor CSS fix (found by the UI pass, pre-existing on master)

Every `.reflect-editor .ProseMirror …` rule from Plan 05 was dead: ProseKit
mounts the ProseMirror view **on** the supplied div (`.reflect-editor` *is*
the `.ProseMirror` root, and carries `data-mark-mode` itself), so descendant
selectors never matched. Symptoms: UA default focus ring around the editor,
unstyled headings/blockquotes/code, markdown syntax modes inert. Fixed by
flattening the selectors onto `.reflect-editor` itself
(`apps/desktop/src/styles/index.css`). This is exactly the class of bug the
jsdom suite cannot see — 200 tests were green throughout.

## Old Reflect references (read-only source survey)

From `/Users/cloud/repos/team-reflect/reflect`:

- `client/screens/main/notes-sidebar/{notes-sidebar,menu}.tsx`,
  `components/sidebar-item/sidebar-item.tsx` — sidebar anatomy, item
  treatment, hover-revealed keycaps.
- `client/screens/main/notes-sidebar/account-nav/account-nav.tsx` — graph
  footer dropdown pattern.
- `client/screens/preferences/{preferences.tsx,preferences-sidebar/menu.tsx,
  preferences-profile/{preferences-profile,theme-picker}.tsx}` — settings
  layout, hairline rows, theme radio cards.
- `lib/keyboard-shortcut.ts`, `components/{shortcuts,shortcut-text}.tsx`,
  `client/screens/main/shortcuts/shortcuts-modal.tsx` — keycap formatter and
  shortcut visibility.
- `components/icons/*.tsx`, `components/ui/*`, `tailwind.config.js` — icon
  discipline, radii/borders/transition polish.

Full observations: `plan.md` §1–2.

## Verification

- Gates at `048da8d`: `pnpm install --frozen-lockfile`, `pnpm typecheck`,
  `pnpm lint`, `pnpm test` (desktop 200 / core 160 / db 4), `pnpm build` —
  all green.
- New tests: `lib/keybindings.test.ts` (formatter), `sidebar/sidebar.test.tsx`
  (nav commands, search affordance, recents feed + navigation, graph
  switcher), settings tests (theme persistence via `updateSettings`, keyboard
  list from real registries, about/version), palette keycap test,
  app-shortcuts coverage for `Mod-\`, core schema test for `theme`.
- UI pass: 9 screenshots in `docs/ui-parity/screenshots/` — chooser,
  workspace, settings (light+dark each), palette recall/query/commands
  (light). All visually verified: sidebar anatomy, keycaps, dark tokens,
  wiki-link chips without visible brackets, styled headings/blockquote/code.

### Native build blocker (documented per plan §6 fallback)

`pnpm tauri dev` fails on this machine because the Rust toolchain is not
installed:

```
failed to run 'cargo metadata' command to get workspace directory:
No such file or directory (os error 2)
```

(no `~/.cargo`, no Homebrew/system cargo). Per the plan's fallback clause the
UI pass ran in a browser: `pnpm dev` + headless Chrome
(`--headless=new --screenshot`, `--force-dark-mode` for dark captures), with
a **temporary dev-only mock IPC bridge** standing in for the Rust backend —
it faked `graph_open`, settings, the index lifecycle, and `db_query` by
pattern-matching the compiled SQL and returning snake_case rows (including
FTS snippets with the `\u0001`/`\u0002` highlight markers). The mock and its
`main.tsx` hook were deleted before commit; no scaffolding ships. The Tauri
runtime itself (window chrome, native dialogs, real IPC) remains unverified
in this pass.

## Caveats / follow-ups

- **Native runtime untested** — see blocker above. A machine with the Rust
  toolchain should smoke-test: graph open via native dialog, watcher-driven
  index updates, quit-flush, window dragging with the headerless shell.
- **Screenshot rig residue**: the pass seeded
  `~/Library/Application Support/reflect-open/recent-graphs.json` and demo
  notes in `/tmp/reflect-ui-demo` on this machine. Left in place (deleting
  risked clobbering a pre-existing file); harmless, remove manually if
  unwanted.
- **Right context region** is intentionally empty — Plan 10 (copilot) owns it.
- Recents currently reuse the index recall feed ordering; a dedicated
  "recently opened" history (vs. recently indexed) may read better long-term.

## Parity backlog (deferred, from plan §4)

- All Notes / Tasks / Map views; pinned notes (needs schema + product
  surfaces — pins don't exist in core yet).
- Right context sidebar content (calendar, note actions, suggested
  backlinks) — Plan 10's region.
- Resizable/persisted sidebar width (original uses a SplitGrid); today fixed
  260px + `⌘\` collapse.
- Standalone shortcuts modal (Settings → Keyboard covers discoverability;
  revisit if a modal earns its keep).
- Tooltip system, toasts, audio recording, templates, import/export UI,
  account/billing — out of open-core scope or no equivalent yet.
- Mod+Shift alternate bindings (app listener deliberately rejects modifier
  combos beyond Mod today).
