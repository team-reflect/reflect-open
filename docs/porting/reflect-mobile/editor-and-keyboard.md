# Porting the editor and keyboard experience

**v2 status: v1 (editing is a hard requirement), with the toolbar
deliberately re-designed.** v2 mounts the desktop editor stack on mobile
(meowdown first, CodeMirror 6 live-preview fallback; Plan 19 decision 7) on
the first-party `plugins/tauri-plugin-keyboard`. V1's native accessory
toolbar is **not** ported (its input-accessory swizzling was brittle). This
doc records what V1's editor did on mobile, especially the toolbar item
set, and the hard-won keyboard/focus lessons.

> **Status (2026-07-02, PR #477): code-side parity shipped.**
> Input hygiene: `spellcheck` is off on the touch surface (WebKit derives
> the keyboard's smart-quotes/dashes traits from it at focus time, not from
> `autocorrect`, which stays on for typo fixes); `autocapitalize` and
> `autocorrect` are set explicitly (`NoteEditor`).
> Focus contract (revised 2026-07-06): navigation never focuses the
> destination editor, because focusing on arrival raises the keyboard
> during the push/pop animation. Wiki-link taps, backlink rows, plain
> arrivals, and back/forward land with the keyboard down. Only explicit
> write gestures focus: the `+` new-note flow (untitled autofocus) and the
> Daily-tab double-tap (the router's one-shot `focusEditor` intent, shared
> with desktop's ⌘D / Daily-notes-row capture, appending at the note's
> end). No V1-style 500 ms timer: focus fires on editor mount, after the
> async load. Keyboard avoidance is **layout, in one place**: the mobile
> shell root is `calc(100dvh - var(--keyboard-height))`, so scroll
> containers, the editor, and floating-ui's boundary (`body`) all end at
> the keyboard's top. The `[[`/`#`/`/` menus fit the visible viewport with
> no per-popup logic; only `position: fixed` elements (the `+` button) read
> the variable. The tab bar hides while the keyboard is up (V1 let the
> keyboard cover it). Checkbox toggles fire the haptics plugin's
> `impact_light`. **Owed to the spike-B gate:** the simulator/device pass
> (smart-punctuation typing, menu tappability, caret visibility, haptic
> feel) and focus restore for wiki links to *daily* notes (owned by the
> daily surface).
>
> **On-device finding (2026-07-06):** programmatic `focus()` does NOT raise
> the keyboard in wry's WKWebView by itself. WebKit gates it on
> `userIsInteracting`, and Reflect's deliberate focuses (the Tasks "+"
> quick-edit sheet, new-note autofocus) run after an async write, outside
> the gesture's event loop (V1 hit the same wall and focused inside
> gestures). The keyboard plugin swizzles `WKContentView`'s
> `_elementDidFocus:userIsInteracting:…` to always report interaction (the
> Capacitor/Cordova `keyboardDisplayRequiresUserAction = false` swizzle).
> Safe under the revised contract, where `focus()` is only an explicit
> write gesture.
>
> **On-device finding (2026-07-04):** `contentInsetAdjustmentBehavior =
> .never` was not enough. On focus, WebKit still scrolls the *native*
> scroll view to reveal the caret (it cannot know the layout already made
> room), pushing the whole app up. The plugin pins
> `scrollView.contentOffset` to zero via KVO; the page is always
> viewport-sized on mobile, so any native offset is that nudge. In the
> simulator, the software keyboard stays hidden while "Connect Hardware
> Keyboard" is on (⇧⌘K; ⌘K toggles the software keyboard). That is a
> simulator setting, not an app bug.
>
> **Status (2026-07-04): the webview-drawn toolbar shipped.** It takes the
> tab bar's slot at the bottom of the shell root while the keyboard is up.
> Since the root ends at the keyboard's top, it sits on the keyboard edge
> with no fixed positioning, and hardware keyboards suppress it for free
> (their overlap is 0, so `keyboardVisible` never flips). Items are V1's
> set below minus AI prediction and image (no v2 substrate yet), plus a
> dismiss button (iOS gives a `contenteditable` no Done key).
> Selection-aware enablement is live ProseKit `canExec`, recomputed on DOM
> `selectionchange` and published through a module store
> (`formatting-toolbar-store.ts`) by a bridge inside the editor's ProseKit
> context (`formatting-toolbar-bridge.tsx`). The store renders `null` when
> the keyboard belongs to a non-editor field (the All-tab search box), and
> per-bridge ownership tokens keep the carousel's mounted editors from
> clobbering each other. Buttons cancel `pointerdown`/`mousedown` so a tap
> never steals focus. **Owed to the device pass:** whether the
> programmatic `[[`/`#`/`/` inserts open their menus (they insert
> correctly; the fallback is a small upstream meowdown command to open
> them), plus haptic feel and per-button focus retention on real WebKit.

## What V1 mobile does

### Editor configuration

`client/screens/note-edit/note-edit-main.tsx` mounts the shared
`@team-reflect/reflect-editor` (ProseMirror + Yjs) with mobile props:
`mobile` on, `inlineToolbarEnabled: false` (the keyboard toolbar replaces
it), merge menu off, `readOnly` false, subject editable except on daily
notes, dark mode and font size from preferences. Backlinks and tags **open
on tap**: tapping `[[…]]` blurs, navigates, and restores focus on the
destination (a `requestedFocusForNoteId` flag on
`client/models/ui/mobile-view.ts`, because iOS allows `focus()` only in the
same event loop as a user gesture).

### The native keyboard accessory toolbar

A Swift plugin (`ios/App/App/Capacitor Plugins/KeyboardToolbarPlugin/`)
swizzles the WKWebView input accessory view to draw a native toolbar above
the keyboard. The webview drives items and enabled states through
`capacitor/keyboard-toolbar.ts`, with a MobX view model
(`client/models/capacitor/keyboard-toolbar-view.ts`) observing selection.

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

Load-bearing behaviors:

- **Selection-aware enablement**: the selection callback reports
  `canIndent`/`canDedent`/`canMoveUp`/`canMoveDown` and buttons update
  live.
- **Hardware-keyboard detection**: Swift observes `GCKeyboard` and hides
  the toolbar when a physical keyboard is attached.
- Shown only while the editor is focused.

### Other mobile editor behavior

- **Autocomplete**: `[[` via the shared entry source; `#` tags with uFuzzy
  (`@leeoniya/ufuzzy`). Both touch-selectable.
- **Image insertion**: toolbar → Capacitor `Camera.pickImages` (1000px max
  width, 80% quality, popover on iPad) → base64 → `editor.uploadImages()`
  (see [assets-and-images](./assets-and-images.md); 50 MB cap in
  `helpers/editor/editor-file-upload-handler.ts`).
- **Checkbox haptic**: `onCheckboxChange` fires a light impact.
- **New-note focus**: creation focuses the editor start after ~500 ms
  (`components/editor/editor-focusing.tsx`), working around iOS focus
  timing.
- **Keyboard spacer**: bottom padding tracks keyboard height.
- **Templates and AI palette** are passed in as on desktop V1.
- **Scar tissue**: `y-prosemirror` is patched for a null-selection crash
  (`patches/y-prosemirror+1.1.3.patch`). WKWebView selection/focus was V1
  mobile's deepest recurring bug source.

## What changes in v2, and why

- **Editor**: meowdown over the desktop document stack wholesale (note
  sessions, debounced atomic saves, title rename, round-trip protection,
  conflict park). No second write path. CM6 live-preview is the fallback if
  meowdown fails the device gate (spike B); read-only is not a fallback.
- **No native accessory bar.** Plan 19 decision 8: the keyboard plugin's
  `--keyboard-height` is the stable primitive; a formatting toolbar, if
  needed, is **webview-drawn**. V1's item set is its starting spec, and
  selection-aware enablement is what made it feel native.
- **AI prediction** has no v2 home yet (no AI on mobile v1); slash commands
  and templates depend on meowdown, not a toolbar.
- **iOS text-input hygiene is a gate criterion**, not polish: smart
  punctuation must not corrupt `[[`/code syntax; `autocapitalize`,
  `autocorrect`, and `spellcheck` are set deliberately.
- Backlink tap → blur → navigate → restore focus ports as behavior via
  mobile route state instead of a MobX flag; restoring the caret on the
  destination is what users feel.

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
