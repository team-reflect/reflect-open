# Porting the AI menu and prompts

**Status: implemented.** The meowdown primitives (selection command menu +
pending-replacement preview) landed via
[prosekit/meowdown#191](https://github.com/prosekit/meowdown/pull/191); until
a meowdown release ships, the app pins pkg.pr.new snapshot builds via the
`pnpm-workspace.yaml` overrides. Select text and press ⌘⇧J (or the sparkle
affordance on the selection), pick a prompt ("Fix spelling and grammar",
"Write a short summary", or one saved in Settings → AI prompts), and the
transformation streams into a preview with Accept / Discard / Retry (with a
one-shot model switch).

## What v1 did

- A prompt picker in the editor ran a chosen prompt against the current
  selection and streamed the reply into the note.
- A library of 23 built-in prompt templates, plus user-created ones (with a
  `{{selectedText}}` placeholder), managed in preferences and synced to the
  account.
- Provider choice (Anthropic / OpenAI / Google) with bundled metered access;
  personal API keys lifted the quotas.

## How it will work in v2

### User experience

1. Select text in a note and invoke the AI menu — via a keyboard shortcut
   registered in the editor keymap, and via a small affordance on the
   selection.
2. A picker lists prompts: a curated built-in set (the most-used v1
   transformations — fix grammar, summarize, rephrase, simplify, continue
   writing, list action items) followed by the user's saved prompts, with
   fuzzy filtering.
3. The result streams into view with explicit **Accept / Discard / Retry**
   controls. Nothing is written to the markdown file until the user accepts;
   a discarded run leaves the note byte-identical.
4. Saved prompts are managed in **Settings → AI**, next to the provider
   configuration that already exists. A prompt has a label and a body with a
   `{{selectedText}}` placeholder (same syntax as v1, so saved v1 prompts
   port over verbatim).

### What changes from v1, and why

| v1                                        | v2                                                      |
| ----------------------------------------- | ------------------------------------------------------- |
| Bundled AI with free/paid daily quotas    | BYOK only — no quotas, no upgrade prompts, no metering  |
| Prompts synced to the cloud account       | Prompts in the user settings file (`reflect.json`), global across graphs |
| Streamed straight into the note           | Preview with Accept/Discard — a save must never surprise the file on disk |
| 23 built-in templates                     | A smaller curated set; the long tail is user-saved      |
| Worked in any note                        | Disabled in `private: true` notes — the selection is note content and can never be sent to a provider |

### Architecture

The work splits cleanly along the existing seams:

- **meowdown** (upstream) grows the editor-level primitives, keeping them
  host-agnostic the way the slash/wikilink/tag menus already are:
  - a selection affordance / command hook the host can populate with items
    (Reflect passes the prompt list, exactly as it passes wikilink
    suggestions today);
  - a "pending replacement" UI: render streamed text as an overlay or
    preview decoration over the selection, with accept (apply as a single
    ProseMirror transaction) / discard (no-op) — this is also the natural
    home for future copilot-driven edits.
- **`@reflect/core`** owns policy: the prompt library schema (zod, in
  `settings/schema.ts` per
  [adding-a-setting](../contributing/adding-a-setting.md)), placeholder
  substitution, and the provider call — reusing the existing AI layer
  (`packages/core/src/ai/`), the provider catalog, keychain-stored keys, and
  the Vercel AI SDK streaming plumbing the copilot already uses.
- **Privacy enforcement** reuses the `CloudSafe` pattern
  (`packages/core/src/ai/checkers.ts`): the selection text must pass the
  same structural check as copilot context, so a private note's content
  cannot typecheck its way to a provider. The UI reflects this by disabling
  the menu in private notes with an explanatory tooltip.

## Explicitly not ported

- Usage limits, quota error messages, and the free/paid distinction — there
  is no metered tier to enforce.
- The "Default (Anthropic)" bundled provider — v2 always uses the user's
  configured provider and key; with no key, the menu is disabled with a
  pointer to Settings (same pattern as audio memos).
- Automatic context beyond the selection (unchanged from v1: prompts see the
  selection only; broader context is the copilot's job).

## Open questions

- Whether the picker is a dedicated selection popover or a filtered mode of
  the command palette (`mod+k`) — leaning popover, since the palette closes
  over the editor and loses the selection visual.
- Whether "Retry" offers a one-shot model switch (cheap to add given the
  provider catalog, but more UI).
- Ordering between the meowdown release and the app work — the meowdown
  primitives land first and independently.
