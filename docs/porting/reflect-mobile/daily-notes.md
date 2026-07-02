# Porting daily notes

**v2 status: v1.** The Daily tab is V1 mobile's signature surface, and the
2026-06-12 product call is explicit V1 design parity: month header + week
calendar strip + touch-swipeable day carousel (Embla in v2). The v2 Today
screen and day pager exist (`apps/desktop/src/mobile/screens/daily.tsx`,
`day-carousel.tsx`, `calendar-strip.tsx`); this doc pins the V1 interaction
details parity should be measured against.

## What V1 mobile does

Implementation: `client/screens/note-edit/note-daily-edit.tsx` (screen),
`note-daily-slide.tsx` (one date), `note-daily-edit-view.ts` (view model),
`components/calendar/calendar-swiper.tsx` (week strip).

### The day carousel

- A horizontal Swiper carousel of date slides with **virtual rendering** —
  only the visible slide and its neighbors mount. The window is a fixed
  span of days around the selected date (dozens in each direction) that
  **re-centers when the user swipes near an edge**, so swiping feels
  infinite in both directions. Future dates are valid capture targets,
  not just the past.
- The component **mounts once and is reused across navigation** to
  preserve swiper state; the route stays `/:graph/daily` and the date is
  written into the URL manually, so Ionic never remounts the screen on a
  date change.
- Scroll position is preserved per slide when swiping between dates.
- **Swiping is disabled while the keyboard is open** — horizontal swipes
  would fight text selection and the caret.
- Daily notes are **created on demand** for dates the carousel reaches
  (`client/models/note/daily-note-store.ts`, IDs `YYYY-MM-DD`).

### The calendar strip

- A week-view strip above the carousel: seven days, selected date
  highlighted, today marked. Swipe left/right to page whole weeks; tap a
  date to jump the carousel there. Strip and carousel stay in sync in
  both directions.
- Respects the user's week-start preference (Sunday/Monday).
- Light haptic on date selection.

### Open-to-today

- The app opens on today, and **re-navigates to today when it wakes from
  background and the date has changed** — open the app, see today.
- Tapping the page title jumps back to today and re-centers the calendar;
  so does double-tapping the Daily tab.

### The slide itself

- The full editor (see [editor-and-keyboard](./editor-and-keyboard.md))
  with the subject **not editable** on daily notes
  (`editableSubject={false}` in `note-daily-slide.tsx`) — the date is the
  identity.
- **Incoming backlinks** render below the content in a collapsible
  section ("Incoming backlinks (N)"), grouped by source note,
  virtualized, expansion state kept in session storage
  (`client/screens/note-edit/incoming-backlinks.tsx`). Tapping a backlink
  to a daily note swipes the carousel there; other notes push the detail
  screen.
- A keyboard spacer (`client/screens/note-edit/keyboard-spacer.tsx`) pads
  the bottom by the live keyboard height so content is never hidden under
  the keyboard.

## What changes in v2, and why

Very little, by design — this surface is the one V1 got most right:

- **Embla replaces Swiper** (recorded in
  [libraries](../../plans/libraries.md)); the virtual-window + re-center
  behavior must be reproduced there.
- Date-keyed encrypted documents become **`daily/YYYY-MM-DD.md` files**.
  Creation-on-reach maps onto desktop's lazy daily-placeholder behavior:
  an empty slide creates **no file** until the first keystroke — swiping
  past days must not materialize files (or dirty sync).
- Backlinks below the note come from the SQLite backlink projection (the
  same getters as desktop) instead of derived Firestore rows.
- The keyboard spacer's job is done by the `--keyboard-height` variable
  from `plugins/tauri-plugin-keyboard` (Today's scroll container already
  yields via `max(safe-area, keyboard)`).
- "Wake to today" and the mount-once carousel pattern port as-is.

## Parity checklist

The v2 Daily screen should have all of:

- [x] Virtual day window, re-centered near edges; past and future both
      reachable; swiping past a day creates no file.
- [x] Carousel ↔ calendar-strip two-way sync; week paging on the strip;
      month header.
- [x] Per-slide scroll preservation; screen never remounts on a date
      change.
- [x] Swipe disabled while the keyboard is up.
- [x] Open-to-today; re-navigate to today on foreground date change;
      title-tap and Daily-tab double-tap jump to today. (v2 note: *any*
      Daily-tab tap navigates to today; a repeat arrival on the shown day —
      V1's double-tap — re-anchors the slide's scroll and re-centers the
      strip, via the router's `arrivalSeq` explicit-intent signal.)
- [x] Week-start setting respected; today visibly marked.
- [x] Daily subject not editable; the date is the title.
- [x] Collapsible incoming-backlinks section below content; daily-note
      backlinks swipe the carousel instead of pushing a screen.
- [x] Haptic on date selection — a light `UIImpactFeedbackGenerator` tap
      via the first-party keyboard plugin's `impact_light` command
      (WKWebView has no `navigator.vibrate`), fired fail-soft from
      `src/mobile/haptics.ts` on day-cell taps (and tab presses, per
      [app-shell-and-navigation](./app-shell-and-navigation.md)).
