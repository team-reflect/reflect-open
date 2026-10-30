# TDR 0005 — iPad: the desktop workspace in regular-width windows

- **Status:** Accepted
- **Date:** 2026-10-25
- **Scope:** What the iOS app renders on an iPad, and which native iPadOS
  surfaces (menu bar, key commands, size classes, context menus) carry the
  desktop app's commands there. The iPhone app is unchanged, and so are the
  iOS app's services: storage, sync, onboarding, subscription, recording.
- **Decision driver:** The mobile grounding brief shipped the iPad as "a big
  phone" and left its posture as an open question
  ([reflect-v2-mobile-grounding-brief.md](../reflect-v2-mobile-grounding-brief.md),
  §10 and §12). On a 13-inch screen with a hardware keyboard, the tab bar,
  week strip and one-column note leave most of the screen empty and every
  keyboard workflow out of reach, while the desktop workspace, which already
  scales down to narrow macOS windows, sits unused in the same bundle.

---

## TL;DR

**A regular-width iPad window renders the desktop workspace; a compact one
renders the phone shell.** The workspace brings the sidebars, the ⌘K palette,
settings and every keyboard shortcut. The iPadOS menu bar, built from the
same command registry as the macOS app menu, carries those shortcuts. Under
both surfaces the app is still the iOS app: same onboarding, paywall, iCloud
and GitHub storage, native audio recorder and background flush.

---

## Decision 1 — The size class picks the surface, not the device

`PlatformFacts.isTablet` marks the iOS build on an iPad (iPadOS asks for
desktop-class pages, so its webview reports a Mac user agent; an iPhone names
itself). On a tablet, `TabletShell` reads the window's horizontal size class
from UIKit (`tauri-plugin-scene`) and renders the desktop workspace while it
is `regular` and the phone shell while it is `compact`. Slide Over, a narrow
Split View pane and a small Stage Manager window therefore behave like an
iPhone, as native iPad apps do.

Both surfaces sit under the one router `MobileApp` mounts per graph, so
crossing between them keeps the current note and its history. Leaving a
surface unmounts its editors, which flush as they would on any navigation.
Scroll offsets do not carry over: a phone carousel page is not a daily-stream
position, so `NavigationService.forgetScrollStates` drops them at the switch.

The size class comes from UIKit and not from a CSS breakpoint because iPadOS
draws the line by device and window, not by a fixed width: half of an 11-inch
iPad in landscape is compact while half of a 13-inch one is regular. Plain
browser dev (`?platform=ipad`) approximates it with a 640px media query.

## Decision 2 — The iOS app's services stay; the workspace adapts to them

`appPlatform` remains `ios` and both `surface` flags stay on, so every core
and app service keeps its iOS behaviour. The shared desktop components adapt
where they assumed a desktop host:

- The frame ends at the software keyboard, because the webview is pinned
  (Plan 19, decision 8), and its columns clear the safe-area insets inside
  their own backgrounds. Like the desktop app, it has no formatting toolbar.
- Audio memos borrow the native recording session that already lives above
  the workspace, and the iOS recording sheet presents them.
- Graphs live in the iOS app's fixed roots: no recents, no folder picker, no
  Finder. The sidebar footer and Settings → Graph open the iOS graph list.
- Settings gains the App Store's subscription controls, and drops the V1
  import (it reads a filesystem path) and the danger zone.
- A Git remote stays mutually exclusive with iCloud Drive (Plan 21).
- Controls the desktop reveals on hover show up front (`touch-app:`).

## Decision 3 — Native menus carry the commands

`tauri-plugin-native-menu` fills the iPadOS 26 menu bar (`UIMainMenuSystem`)
from the macOS app menu's layout, minus the commands an iPad cannot run yet
(open in new window, the web inspector). On iPadOS a main-menu key command
claims its keystroke before the webview sees it, so each shortcut runs
through the same guarded dispatch as a click on its item. The plugin removes
the system element groups whose shortcuts would shadow Reflect's: text
formatting (WebKit's ⌘B/⌘I/⌘U would write HTML into the markdown editor),
Find, the sidebar, and the Settings app link. While the phone shell is up,
the menu bar keeps only the system's items. Before iPadOS 26 there is no menu
bar, and shortcuts reach the webview's keydown handling as before.

Context menus present natively at the pointer (`UIEditMenuInteraction`), as a
context menu for a trackpad's secondary click.

## Not yet

- **Multiple windows.** Tauri 2.12 supports UIScene windows on iOS, but the
  desktop model (note windows adopt the main window's graph session and close
  with it) breaks when iPadOS discards a background main scene. It needs its
  own design and lands separately.
- **Touch context menus.** A long-press would compete with drag-to-reorder on
  the same rows; a trackpad's secondary click opens them today.
