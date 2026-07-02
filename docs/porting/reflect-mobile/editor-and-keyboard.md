# Porting the editor and keyboard experience

**v2 status: v1 (editing is a hard requirement), with the toolbar
deliberately re-designed.** v2 mounts the real desktop editor stack on
mobile (meowdown first, CodeMirror 6 live-preview fallback — Plan 19
decision 7), on top of the first-party `plugins/tauri-plugin-keyboard`.
V1's native accessory toolbar is explicitly **not** ported (its
input-accessory swizzling was brittle); a webview-drawn toolbar may come
later. This doc records what V1's editor did on mobile — most importantly
the toolbar item set, which is the requirements list for that later
toolbar — and the hard-won keyboard/focus lessons.

> **Status (2026-07-02, PR #477): the code-side parity items shipped.**
> Input hygiene: `spellcheck` is pinned off on the touch surface — WebKit
> derives the keyboard's smart-quotes/smart-dashes traits from it at focus
> time (not from `autocorrect`, which stays on for typo fixing) — and
> `autocapitalize`/`autocorrect` are set explicitly (`EditorInputTraits`).
> Focus contract: wiki-link taps and backlink rows navigate with the
> router's one-shot `focusEditor` arrival intent, which the mobile note
> screen consumes into `autoFocus`; plain arrivals and back/forward never
> raise the keyboard; no V1-style 500 ms timer (focus fires on editor
> mount, after the async document load). Keyboard avoidance is by
> **layout, in one place**: the mobile shell root is
> `calc(100dvh - var(--keyboard-height))`, so scroll containers, the
> editor, and floating-ui's positioning boundary (`body`) all end at the
> keyboard's top — the `[[`/`#`/`/` menus position inside the visible
> viewport with no per-popup fitting, and only `position: fixed` elements
> (the `+` button) read the variable themselves. The tab bar hides while
> the keyboard is up (V1 let the keyboard cover it). Checkbox-toggle
> haptics ride the keyboard plugin's `impact_light` command like the
> date/tab taps. **Still owed to the spike-B gate:** the simulator/
> on-device pass — smart-punctuation typing test, whether programmatic
> `focus()` raises the keyboard in wry's WKWebView, menu tappability,
> caret visibility, haptic feel — plus focus restore for wiki links
> resolving to *daily* notes (the daily surface owns that).

## What V1 mobile does

### Editor configuration

The shared `@team-reflect/reflect-editor` (ProseMirror + Yjs) is mounted
by `client/screens/note-edit/note-edit-main.tsx` with mobile-specific
props: `mobile` mode on, `inlineToolbarEnabled: false` (the keyboard
toolbar replaces it), merge menu off, `readOnly` always false, subject
editable on regular notes but not daily notes, dark mode and font-size
props from preferences. Backlinks and tags **open on tap** instead of
becoming selectable — tapping `[[…]]` blurs the editor, navigates, and
restores focus on the destination (a `requestedFocusForNoteId` flag on
`client/models/ui/mobile-view.ts`, because iOS only allows `focus()` in
the same event loop as a user gesture).

### The native keyboard accessory toolbar

The signature mobile editor affordance. A Swift Capacitor plugin
(`ios/App/App/Capacitor Plugins/KeyboardToolbarPlugin/`) swizzles the
WKWebView input accessory view to render a native toolbar above the iOS
keyboard; the webview drives its items and enabled states through
`capacitor/keyboard-toolbar.ts`, with a MobX view model
(`client/models/capacitor/keyboard-toolbar-view.ts`) observing editor
selection.

The item set (left to right):

| Item        | Action                                              |
| ----------- | ---------------------------------------------------- |
| Slash       | `editor.insertText('/')` — opens slash commands      |
| AI          | `editor.togglePrediction()` — AI autocomplete toggle |
| Bullet      | `editor.turnToBulletList()`                          |
| Task        | `editor.turnToTaskList()`                            |
| Backlink    | `editor.insertText('[[')` — triggers autocomplete    |
| Tag         | `editor.insertText('#')` — triggers autocomplete     |
| Outdent     | `dedentListItem()` — disabled unless nested          |
| Indent      | `indentListItem()` — disabled unless in a list       |
| Move up     | `moveUpListItem()`                                   |
| Move down   | `moveDownListItem()`                                 |
| Image       | photo picker → editor upload pipeline                |

Load-bearing behaviors around it:

- **Selection-aware enablement**: the editor's selection callback reports
  `canIndent`/`canDedent`/`canMoveUp`/`canMoveDown`, and the view model
  enables/disables buttons live.
- **Hardware-keyboard detection**: the Swift side observes `GCKeyboard`
  and hides the toolbar when a physical keyboard is attached.
- Shown only while the editor is focused; hidden with the keyboard.

### Other mobile editor behavior

- **Autocomplete**: `[[` backlink autocomplete via the shared entry
  source; `#` tag autocomplete with uFuzzy matching
  (`@leeoniya/ufuzzy`). Both must be touch-selectable.
- **Image insertion**: toolbar image button → Capacitor
  `Camera.pickImages` (1000px max width, 80% quality, popover on iPad) →
  base64 → `editor.uploadImages()` (see
  [assets-and-images](./assets-and-images.md); 50 MB cap in
  `helpers/editor/editor-file-upload-handler.ts`).
- **Checkbox haptic**: `onCheckboxChange` fires a light haptic impact.
- **New-note focus**: creation auto-focuses the editor start after a
  ~500 ms delay (`components/editor/editor-focusing.tsx`) — the delay
  works around iOS focus timing.
- **Keyboard spacer**: bottom padding tracks live keyboard height so the
  caret is never occluded.
- **Templates and AI palette** are passed into the editor (content
  templates, prompt templates, prediction) — same props as desktop V1.
- **The scar tissue**: `y-prosemirror` is patched via patch-package for a
  null-selection crash (`patches/y-prosemirror+1.1.3.patch`). WKWebView
  selection/focus behavior was V1 mobile's deepest recurring bug source.

## What changes in v2, and why

- **Editor**: meowdown (desktop's editor) mounted by the mobile note
  screen, over the desktop document stack wholesale — note sessions,
  debounced atomic saves, title rename, round-trip protection, conflict
  park. No second write path. CM6 live-preview is the fallback rung if
  meowdown fails the on-device gate (spike B); read-only is not a rung.
- **No native accessory bar.** Plan 19 decision 8: the keyboard plugin's
  height events (`--keyboard-height`) are the stable primitive; if
  editing on touch demands a formatting toolbar, it will be
  **webview-drawn** and positioned via those events. When that day comes,
  V1's item set above is the starting spec — and selection-aware
  enablement is the part that made it feel native, not the buttons
  themselves.
- **AI prediction toggle** has no v2 home yet (no AI on mobile v1); slash
  commands and templates depend on the meowdown feature set rather than a
  toolbar.
- **iOS text-input hygiene is a gate criterion**, not polish: smart
  punctuation must not corrupt `[[`/code syntax; `autocapitalize`/
  `autocorrect`/`spellcheck` are set deliberately on the editing surface.
- Backlink-tap → blur → navigate → restore-focus ports as product
  behavior; the mechanism is the mobile route state rather than a MobX
  focus flag, but the "restore the caret on the destination" contract is
  the part users feel.

## V1 → v2 mapping

| V1                                                | v2                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| reflect-editor (ProseMirror+Yjs), `mobile` mode   | meowdown (or CM6 fallback) over the shared document stack        |
| Native accessory toolbar (swizzled)               | Not ported; webview-drawn toolbar later, on keyboard-height      |
| Toolbar item set + selection-aware enablement     | The requirements list for that later toolbar                     |
| Hardware-keyboard detection (GCKeyboard)          | Revisit with the toolbar (hide it for hardware keyboards)        |
| Keyboard spacer component                         | `--keyboard-height` CSS var; scroll container yields to it       |
| `[[` / `#` autocomplete on touch                  | Wiki-link autocomplete shipped; tags per desktop parity          |
| Camera → base64 → upload pipeline                 | Later; assets are plain files (see assets doc)                   |
| y-prosemirror selection patch                     | The reason spike B gates the editor on a real device             |
| Checkbox haptic, 500 ms create-focus delay        | Port as polish once editing passes the gate                      |
