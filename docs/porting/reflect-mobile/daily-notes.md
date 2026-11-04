# Porting daily notes

**v2 status: v1.** The Daily tab is V1 mobile's signature surface, and the
2026-06-12 product call is V1 design parity: month header + week calendar
strip + swipeable day carousel (Embla in v2). The v2 screen exists
(`apps/desktop/src/mobile/screens/daily.tsx`, `day-carousel.tsx`,
`calendar-strip.tsx`); this doc pins the V1 details to measure against.

## What V1 mobile does

Implementation: `client/screens/note-edit/note-daily-edit.tsx` (screen),
`note-daily-slide.tsx` (one date), `note-daily-edit-view.ts` (view model),
`components/calendar/calendar-swiper.tsx` (week strip).

### The day carousel

- A horizontal Swiper with **virtual rendering**: only the visible slide
  and its neighbors mount. The window spans dozens of days each way and
  **re-centers when the user swipes near an edge**, so it feels infinite.
  Future dates are valid capture targets.
- The component **mounts once and is reused across navigation**: the route
  stays `/:graph/daily` and the date is written into the URL manually, so
  Ionic never remounts on a date change.
- Scroll position is kept per slide.
- **Swiping is disabled while the keyboard is open**; horizontal swipes
  would fight text selection and the caret.
- Daily notes are **created on demand** for dates the carousel reaches
  (`client/models/note/daily-note-store.ts`, IDs `YYYY-MM-DD`).

### The calendar strip

- A seven-day strip above the carousel, selected date highlighted, today
  marked. Swipe to page weeks; tap to jump. Strip and carousel stay in sync
  both ways.
- Respects the week-start preference (Sunday/Monday).
- Light haptic on date selection.

### Open-to-today

- The app opens on today and **returns to today on wake if the date
  changed**.
- Tapping the page title, or double-tapping the Daily tab, jumps to today
  and re-centers the calendar.

### The slide itself

- The full editor (see [editor-and-keyboard](./editor-and-keyboard.md))
  with the subject **not editable** on daily notes
  (`editableSubject={false}` in `note-daily-slide.tsx`): the date is the
  identity.
- **Incoming backlinks** render below content in a collapsible section
  ("Incoming backlinks (N)"), grouped by source, virtualized, expansion
  kept in session storage
  (`client/screens/note-edit/incoming-backlinks.tsx`). A backlink to a
  daily note swipes the carousel there; others push the detail screen.
- A keyboard spacer (`client/screens/note-edit/keyboard-spacer.tsx`) pads
  the bottom by the live keyboard height.

## What changes in v2, and why

Very little, by design; this is the surface V1 got most right:

- **Embla replaces Swiper** ([libraries](../../plans/libraries.md)); the
  virtual window + re-center behavior must be reproduced.
- Encrypted date documents become **`daily/YYYY-MM-DD.md` files**.
  Creation-on-reach maps onto desktop's lazy daily placeholder: an empty
  slide creates **no file** until the first keystroke, so swiping past
  days never makes files (or dirties sync).
- Backlinks come from the SQLite backlink projection (same getters as
  desktop).
- The keyboard spacer's job is done by `--keyboard-height` from
  `plugins/tauri-plugin-keyboard` (Today's scroll container yields via
  `max(safe-area, keyboard)`).
- Wake to today and the mount-once carousel port as-is.

## Parity checklist

The v2 Daily screen should have all of:

- [x] Virtual day window, re-centered near edges; past and future both
      reachable; swiping past a day creates no file.
- [x] Carousel ↔ calendar-strip two-way sync; week paging on the strip;
      month header.
- [x] Per-slide scroll preservation; screen never remounts on a date
      change.
- [x] Swipe disabled while the keyboard is up.
- [x] Open-to-today; return to today on foreground date change; title tap
      and Daily-tab double-tap jump to today. (v2: *any* Daily-tab tap goes
      to today; a repeat arrival on the shown day, V1's double-tap,
      re-anchors the slide's scroll and re-centers the strip via the
      router's `arrivalSeq` explicit-intent signal.)
- [x] Week-start setting respected; today visibly marked.
- [x] Daily subject not editable; the date is the title.
- [x] Collapsible incoming-backlinks section; daily-note backlinks swipe the
      carousel instead of pushing a screen.
- [x] Haptic on date selection: a light `UIImpactFeedbackGenerator` tap via
      the haptics plugin's `impact_light` (WKWebView has no
      `navigator.vibrate`), fired fail-soft from `src/mobile/haptics.ts` on
      day-cell taps (and tab presses, per
      [app-shell-and-navigation](./app-shell-and-navigation.md)).
