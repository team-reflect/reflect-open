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
const { settings, updateSettings } = useSettings()
// read:  settings.yourNewSetting
// write: updateSettings({ yourNewSetting: value })
```

Semantics you get for free from the provider (and must not re-implement):

- **Instant apply.** `updateSettings` merges into local state immediately;
  defaults are usable before the disk load settles, so there is no loading
  gate to handle.
- **Async, ordered persistence.** Writes are chained in apply order, trail
  hydration (nothing is written before the disk document has been read), and
  save the full merged document. Failures surface through the operations
  status UI and retry on the next change or the quit flush.
- **No save button.** Settings apply live — design your control accordingly.

## 3. Add the control

`apps/desktop/src/components/settings-screen.tsx` is a routed view (⌘, or the
palette's "Open settings"). Follow the existing pattern: a `<section>` per
group, a `<fieldset>` with a `legend` and a one-line description per setting,
and `onChange` calling `updateSettings` directly. Add a test in
`settings-screen.test.tsx` — the existing ones render the screen inside the
*real* provider over a fake bridge (`setBridge`), interact with the control,
and assert the document that reaches `settings_save`. That covers the whole
chain (control → patch → merge → persist), not just the click handler.

## Checklist

- [ ] Value schema with `.catch(default)` added to `settingsSchema`
- [ ] New types exported from `packages/core/src/index.ts`
- [ ] Schema tests: missing → default, invalid → default, valid round-trips
- [ ] Control in `settings-screen.tsx` wired to `updateSettings`
- [ ] Screen test covering the new control
- [ ] No Rust changes, no migrations, no per-key save logic
