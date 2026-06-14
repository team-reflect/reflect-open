# Adding a user setting

User settings are one JSON document in the OS config dir (next to the recents
store — never inside a graph's `.reflect/`, because preferences follow the
user across graphs and must survive graph deletion). The split of
responsibilities follows the usual rule:

- **Rust** (`apps/desktop/src-tauri/src/settings.rs`) persists the document as
  an *opaque* JSON object — atomic writes, corrupt-store-errors-loudly. It has
  no idea what keys exist. **You will not touch Rust to add a setting.**
- **`@reflect/core`** (`packages/core/src/settings/schema.ts`) owns the known
  keys, their defaults, and validation.
- **The desktop app** consumes settings through `useSettings()`
  (`apps/desktop/src/providers/settings-provider.tsx`) and renders controls in
  section components under `apps/desktop/src/components/settings/`, composed by
  `settings-screen.tsx`.

## 1. Declare the key in the schema

Add a field to `settingsSchema` in `packages/core/src/settings/schema.ts`:

```ts
export const editorMarkdownSyntaxSchema = z.enum(['focus', 'show']).catch('focus')

export const settingsSchema = z
  .object({
    editorMarkdownSyntax: editorMarkdownSyntaxSchema,
    // yourNewSetting: yourNewSettingSchema,
  })
  .passthrough()
```

The resilience contract (it mirrors the frontmatter schema):

- **Every value schema ends in `.catch(default)`.** A missing *or invalid*
  value degrades to its default instead of failing the whole load. Because of
  this, `DEFAULT_SETTINGS` (`settingsSchema.parse({})`) picks up your default
  automatically — there is no separate defaults table to update, and there are
  no migrations: an old document simply lacks the key and parses to the
  default.
- **`.passthrough()` keeps unknown keys.** A document written by a newer app
  version round-trips through an older one without losing fields. This is also
  why saves always write the *full merged document*, never a single key.
- **Name the persisted key implementation-neutrally.** The document outlives
  any one library: `editorMarkdownSyntax`, not `meowdownMarkMode` — map to the
  library's vocabulary at the consuming boundary instead.

Export any new value type from `packages/core/src/index.ts` (alongside
`EditorMarkdownSyntax`). Cover the new key in
`packages/core/src/settings/schema.test.ts`: default on missing, degrade on
invalid, accepted values pass through.

## 2. Consume it

```tsx
const { settings, updateSettings, updateSettingsWith } = useSettings()
// read:  settings.yourNewSetting
// write scalar: updateSettings({ yourNewSetting: value })
// write derived/list value: updateSettingsWith((current) => ({ yourList: nextList(current) }))
```

Semantics you get for free from the provider (and must not re-implement):

- **Instant apply.** `updateSettings` merges into local state immediately;
  defaults are usable before the disk load settles, so there is no loading
  gate to handle.
- **Async, ordered persistence.** Writes are chained in apply order, trail
  hydration (nothing is written before the disk document has been read), and
  save the full merged document. Failures surface through the operations
  status UI and retry on the next change or the quit flush.
- **Functional updates for read-modify-write.** Use `updateSettingsWith` for
  list/object edits or anything derived from the current document. Updaters
  dispatched before hydration are queued and replayed over the loaded
  document, so an early edit cannot accidentally compute from defaults and
  wipe the stored value.
- **Load-sensitive side effects must await hydration.** If a settings entry is
  paired with state elsewhere (for example an OS-keychain secret), call
  `whenSettingsLoaded()` before writing the other half. If the initial load
  failed, settings are session-only and the paired write would be stranded.
- **No save button.** Settings apply live — design your control accordingly.

## 3. Add the control

`apps/desktop/src/components/settings-screen.tsx` is a routed view (⌘, or the
palette's "Open settings") composed of one section component per group under
`apps/desktop/src/components/settings/`. Add new groups to
`SETTINGS_SECTIONS` (`settings/sections.ts`) and render the matching component
from `SettingsScreen`; the sticky navigator and section DOM ids derive from
that registry.

Build the section from the shared settings primitives rather than hand-rolling
the section/card markup:

- `SettingsSection` (`section.tsx`) — the heading + bordered card per group.
- `SettingsField` (`field.tsx`) — the `<fieldset>` with a `legend` and a
  one-line description per setting.
- `SettingsOptionCard` (`option-card.tsx`) — one choice in a radio group, with
  the shared selected/hover/focus treatment.

For controls and overlays, check `apps/desktop/src/components/ui/` first and
use the existing shadcn primitive (`Switch`, `Select`, `Dialog`, `Popover`,
`Tooltip`, etc.) rather than building a custom one.

`onChange` calls `updateSettings` or `updateSettingsWith` directly (see
`appearance-section.tsx`, `editor-section.tsx`, and `all-notes-section.tsx` for
the common shapes). Add the test at the narrowest useful level:

- For a setting whose value should round-trip through the provider, use
  `settings-screen.test.tsx`: it renders the screen inside the *real* provider
  over a fake bridge (`setBridge`), interacts with the control, and asserts the
  document that reaches `settings_save`.
- For a section with its own branching behavior or provider dependencies, add
  a focused section test next to it (for example `backup-section.test.tsx` or
  `rebuild-index-field.test.tsx`) and mock only the surrounding providers.

## Checklist

- [ ] Value schema with `.catch(default)` added to `settingsSchema`
- [ ] New types exported from `packages/core/src/index.ts`
- [ ] Schema tests: missing → default, invalid → default, valid round-trips
- [ ] Section under `components/settings/` built from the shared primitives,
      wired to `updateSettings`
- [ ] New section registered in `settings/sections.ts` and rendered from
      `settings-screen.tsx` if it adds a group
- [ ] Screen/provider test for persistence, plus focused section tests for
      section-specific behavior where needed
- [ ] No Rust changes, no migrations, no per-key save logic
