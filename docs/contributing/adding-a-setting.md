# Adding a user setting

User settings are one JSON document in the OS config dir (next to the recents
store — never inside a graph's `.reflect/`, because preferences follow the
user across graphs and must survive graph deletion). The split of
responsibilities follows the usual rule:

- **Rust** (`apps/desktop/src-tauri/src/settings.rs`) persists the document as
  an *opaque* JSON object — atomic writes, corrupt-store-errors-loudly. It has
  no idea what keys exist. **You will not touch Rust to add a setting.**
- **`@reflect/core`** owns the known keys, their defaults, and validation
  (`packages/core/src/settings/schema.ts`), and the runtime document:
  `SettingsService` (`settings/settings-service.ts`, `CoreServices.settings`)
  loads it once, applies patches, and persists them.
- **The desktop app** consumes settings through `useSettings()`
  (`apps/desktop/src/providers/settings-provider.tsx`, a thin shell over the
  service) and renders controls in section components under
  `apps/desktop/src/components/settings/`, composed by `settings-screen.tsx`.

## 1. Declare the key in the schema

Add a field to `settingsSchema` in `packages/core/src/settings/schema.ts`:

```ts
export const editorMarkdownSyntaxSchema = z.enum(['hide', 'show', 'hybrid']).catch('hide')

export const settingsSchema = z.looseObject({
  editorMarkdownSyntax: editorMarkdownSyntaxSchema,
  // yourNewSetting: yourNewSettingSchema,
})
```

The resilience contract (it mirrors the frontmatter schema):

- **Every value schema ends in `.catch(default)`.** A missing *or invalid*
  value degrades to its default instead of failing the whole load. Because of
  this, `DEFAULT_SETTINGS` (`settingsSchema.parse({})`) picks up your default
  automatically — there is no separate defaults table to update, and there are
  no migrations: an old document simply lacks the key and parses to the
  default.
- **`z.looseObject` keeps unknown keys.** A document written by a newer app
  version round-trips through an older one without losing fields. This is also
  why saves always write the *full merged document*, never a single key.
- **Name the persisted key implementation-neutrally.** The document outlives
  any one library: `editorMarkdownSyntax`, not `meowdownMarkMode` — map to the
  library's vocabulary at the consuming boundary instead.

Export any new value type from the package root,
`packages/core/src/index.ts` (alongside `EditorMarkdownSyntax`). Cover the new key in
`packages/core/src/settings/schema.test.ts`: default on missing, degrade on
invalid, accepted values pass through.

## 2. Consume it

```tsx
const { settings, updateSettings, updateSettingsWith } = useSettings()
// read:  settings.yourNewSetting
// write scalar: updateSettings({ yourNewSetting: value })
// write derived/list value: updateSettingsWith((current) => ({ yourList: nextList(current) }))
```

Outside React (a core service, a `lib/` function), read and write the same
document through the service: `settings.get()`, `settings.update(patch)`,
`settings.updateWith(updater)`, `settings.subscribe(listener)`. A core service
takes `settings` in its `deps`.

Semantics you get for free from `SettingsService` (and must not re-implement):

- **Instant simple patches.** `updateSettings` applies over defaults while the
  disk load is pending. After the load, it updates the current document, and
  every subscriber sees the new one at once.
- **Async, ordered persistence.** Each change after the load submits the full
  merged document to `settings_save`. Saves run one at a time, in apply order,
  and nothing is submitted before the disk document has been read. A failed
  save keeps the in-memory value, surfaces through the operations status UI,
  and leaves the document dirty for the next change or quit flush to retry.
- **Functional updates for read-modify-write.** Use `updateSettingsWith` for
  list/object edits or anything derived from the current document. Updaters
  dispatched before the load are queued and replayed over the loaded
  document, so an early edit cannot accidentally compute from defaults and
  wipe the stored value.
- **One runtime document.** The service holds the only copy. `useSettings()`
  and `settings.get()` return the same object, and it keeps its identity (and
  the identity of unchanged nested values) until something really changes.
  The settings JSON remains the durable source. Quit and background flushes
  (`PersistenceFlushService` calling `settings.flush()`) drain submitted
  saves, then resubmit and await the current document when its last save was
  not confirmed.
- **Load-sensitive side effects must await the load.** If a settings entry is
  paired with state elsewhere (for example an OS-keychain secret), call
  `whenSettingsLoaded()` (`settings.whenLoaded()`) before writing the other
  half. If the initial load failed, settings are session-only and the paired
  write would be stranded.
- **Load failure is session-only.** Simple and functional updates still apply
  over defaults for the current session, but the service never writes over an
  unreadable or corrupt settings document.
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

- For a setting whose value should round-trip, render the screen or the
  section with `renderInApp` (the *real* provider over the test services),
  interact with the control, and assert the saved settings
  (`core.settings.get()` or `core.settings.saves()`). Start from a stored value
  with the `settings` option: `renderInApp(ui, { settings: { yourNewSetting } })`.
- For a section with its own branching behavior, add a focused section test
  next to it (for example `backup-section.test.tsx` or
  `rebuild-index-field.test.tsx`), also with `renderInApp`. Drive the services
  it reads through `core`; do not mock the providers. See
  [testing](testing.md).

## Checklist

- [ ] Value schema with `.catch(default)` added to `settingsSchema`
- [ ] New types exported from `packages/core/src/index.ts`
- [ ] Schema tests: missing → default, invalid → default, valid round-trips
- [ ] Section under `components/settings/` built from the shared primitives,
      wired to `updateSettings`
- [ ] New section registered in `settings/sections.ts` and rendered from
      `settings-screen.tsx` if it adds a group
- [ ] `renderInApp` test asserting `core.settings` for persistence, plus focused
      section tests for section-specific behavior where needed
- [ ] No Rust changes, no migrations, no per-key save logic
