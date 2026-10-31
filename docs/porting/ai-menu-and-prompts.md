# Porting the AI menu and prompts

**Status: implemented.** The meowdown primitives (selection command menu +
pending-replacement preview) shipped upstream in
[prosekit/meowdown#191](https://github.com/prosekit/meowdown/pull/191)
(meowdown 0.33.0). Select text and press ⌘⇧J (or the sparkle affordance),
pick a prompt (built-in or saved in Settings → AI prompts), and the result
streams into a preview with Accept / Discard / Retry (with a one-shot model
switch).

## What v1 did

- An editor prompt picker ran a prompt against the selection and streamed
  the reply into the note.
- 23 built-in prompt templates plus user prompts (with a `{{selectedText}}`
  placeholder), synced to the account.
- Anthropic / OpenAI / Google with bundled metered access; personal API keys
  lifted the quotas.

## How it works in v2

### User experience

1. Select text and invoke the AI menu by keyboard shortcut or the selection
   affordance.
2. The picker lists the user's saved prompts first (v1's order), then a
   curated built-in set with v1's bodies (fix grammar, copy editor, rephrase,
   simplify, format paragraphs, short summary, key takeaways, action items,
   points to document, next paragraph, decorate with backlinks), with label
   filtering. Typed text that matches nothing runs as a one-off prompt (v1's
   "Ask anything to AI"). The rest of v1's 23 stay unported; users can
   recreate them as saved prompts.
3. The result streams into a preview with **Accept / Discard / Retry**, plus
   the alternate placement (v1's Replace-vs-Insert: "Insert below" on a
   replace prompt, "Replace selection" on an append one). Nothing is written
   until the user accepts; a discard leaves the note byte-identical.
4. Saved prompts live in **Settings → AI**: a label and a body with a
   `{{selectedText}}` placeholder (v1 syntax, so v1 prompts port verbatim).

### What changes from v1, and why

| v1                                        | v2                                                      |
| ----------------------------------------- | ------------------------------------------------------- |
| Bundled AI with free/paid daily quotas    | BYOK only — no quotas, no upgrade prompts, no metering  |
| Prompts synced to the cloud account       | Prompts in the user settings file (`reflect.json`), global across graphs |
| Streamed straight into the note           | Preview with Accept/Discard — a save must never surprise the file on disk |
| 23 built-in templates                     | A smaller curated set; the long tail is user-saved      |
| Worked in any note                        | Disabled in `private: true` notes — the selection is note content and can never be sent to a provider |

### Architecture

- **meowdown** (upstream) owns host-agnostic editor primitives, like the
  slash/wikilink/tag menus: a selection command hook the host fills with
  items, and a "pending replacement" preview over the selection with accept
  (one ProseMirror transaction) / discard (no-op). That preview is also the
  natural home for future copilot edits.
- **`@reflect/core`** owns policy: the prompt schema (zod, in
  `settings/schema.ts` per
  [adding-a-setting](../contributing/adding-a-setting.md)), placeholder
  substitution, and the provider call, reusing the copilot's AI layer
  (`packages/core/src/ai/`), provider catalog, keychain keys, and Vercel AI
  SDK streaming.
- **Privacy** reuses `CloudSafe`
  (`packages/core/src/privacy/privacy-service.ts`): the selection passes the
  same structural check as copilot context, so private content cannot
  typecheck its way to a provider. The menu is disabled in private notes
  with an explanatory tooltip.

## Explicitly not ported

- Usage limits, quota errors, and the free/paid distinction.
- The "Default (Anthropic)" bundled provider. With no key, the menu is
  disabled with a pointer to Settings (same as audio memos).
- Context beyond the selection (same as v1; broader context is the
  copilot's job).

## Resolved questions

- The picker is a dedicated selection popover, not a command-palette mode:
  the palette covers the editor and loses the selection visual.
- Retry offers a one-shot model switch (`AiPreviewActions` renders a model
  dropdown from the configured providers' catalogs; the pick applies to that
  retry only).
- The meowdown primitives landed first (meowdown#191, 0.33.0); the app used
  pkg.pr.new snapshots during development and now uses the npm release.
