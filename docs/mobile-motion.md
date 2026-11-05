# Mobile motion: engine facts

The mobile gesture and scroll code (`apps/desktop/src/lib/scroll-settle.ts`,
`apps/desktop/src/lib/scroll-pager.ts`, `apps/desktop/src/mobile/`) relies on the browser engine
facts below. Each fact names the engines it was verified on. Do not remove a workaround for a fact
here until you verify that the fact changed on every engine we ship to.

## Engines

| Name in this doc  | Engine                                                   |
| ----------------- | -------------------------------------------------------- |
| Chromium          | Chromium 156 in Playwright                               |
| Playwright WebKit | WebKit 27.2 in Playwright                                |
| Safari            | Safari 27.0.1 on macOS                                   |
| iOS               | Safari on iOS 26.4 (iPhone 17 Pro simulator, real touch) |

The minimum iOS target is 16.2 (`deploymentTarget` in
`apps/desktop/src-tauri/gen/apple/project.yml`). Engines in the supported range can be older
than the ones above.

**Playwright WebKit is not Safari for scroll snap.** The two differ on snap behavior (see
[DOM changes under a snapped scroller](#dom-changes-under-a-snapped-scroller)). Verify every snap
assumption in Safari or in the iOS simulator
([docs/contributing/mobile-simulator.md](contributing/mobile-simulator.md)).

## Scroll snap

### Turning snap back on

- When `scroll-snap-type` goes from `none` back to a snap type, the element moves to the nearest
  snap position at the next layout. A layout read (for example `scrollLeft`) forces this move
  synchronously, so the read returns the snap position. Verified: Chromium, Playwright WebKit,
  Safari.
- The browser picks the snap position nearest to the current position, not the position where a
  drag started. Verified: Chromium, Playwright WebKit, Safari.
- In Safari and Playwright WebKit, this move is an instant jump. `scrollTo({ behavior: 'smooth' })`
  and CSS `scroll-behavior: smooth` do not animate it. Chromium animates it only under
  `scroll-behavior: smooth`.
- To animate to the snap position: turn snap on, read the position, turn snap off, put the
  position back, then `scrollTo({ behavior: 'smooth' })`, all in one task. No frame paints the
  jump. Verified: Chromium, Playwright WebKit, Safari. Code: the mouse drag release in
  `scroll-settle.ts`.

### DOM changes under a snapped scroller

- When elements are inserted or removed before the snapped element of a resting
  `scroll-snap-type: x mandatory` scroller, Safari and iOS do not keep the snapped element. The
  scroller stays at the old offset and shows a different element. Chromium and Playwright WebKit
  keep the snapped element.
- If code restores the position in the next frame, Safari and iOS paint the wrong element for one
  frame. If code restores it in the same task as the DOM change, no engine paints it. In React,
  restore in a `useLayoutEffect`. Verified: all four engines.

### Scroll writes during a gesture

- On iOS, after a finger touches down, the pan owns the position until the gesture ends. A
  `scrollLeft` write lasts only until the next finger move, which puts the position back to the
  touch-down position plus the finger offset. If the write came with a DOM shift (see above), the
  scroller shows a different element. Verified: iOS.
- On iOS, a write during momentum stops the momentum, and the scroller snaps to the nearest snap
  position. Verified: iOS.
- Chromium keeps a write during a drag, and the drag goes on from the new position. Browser tests
  in Chromium cannot catch the iOS behavior. Verified: Chromium.
- So a pager can shift its pages in the DOM (for example, to re-center its window) only at rest.
  A write without a DOM shift, such as a jump that cancels a swipe, is safe: it stops momentum, and
  a drag overwrites it. A check for a finger in the React commit cannot prevent a mid-gesture
  shift: the native pan starts while the main thread is busy, and the `touchstart` waits
  until the commit ends (inferred, not probed directly).

### Resize

- When the page width of a snapped scroller changes, Chromium fires `scroll` before the
  `ResizeObserver` callback runs. A settle handler can see the intermediate position.

## Touch events

- If the touched node is removed while the finger is down, the later `touchend` (or `touchcancel`)
  goes only to the removed node. It does not reach the scroller or a capture listener on
  `document`. Verified: Chromium, Playwright WebKit, iOS.
- `Touch.identifier` on iOS is unique and increases with each touch. Chromium (touch emulation
  through CDP) uses `0` for every touch. So on iOS, no later touch clears the identifier of a
  missed `touchend`. In Chromium tests, the next touch reuses and clears it.
- `event.touches` in `touchstart` lists every finger that is down. Verified: Playwright.
- During a drag, the browser fires `pointercancel` when it takes over the native pan, while the
  finger is still down. Pointer events cannot tell when a finger lifts. Verified: Playwright.

## APIs

| API                                              | Chromium | Playwright WebKit | Safari | iOS    |
| ------------------------------------------------ | -------- | ----------------- | ------ | ------ |
| `scrollend`                                      | yes      | yes               | yes    | yes    |
| `scrollsnapchanging`, `scrollsnapchange`         | yes      | no                | no     | no     |
| `ScrollTimeline`, `animation-timeline: scroll()` | yes      | yes               | yes    | yes    |
| `Element.getAnimations()`                        | yes      | yes               | yes    | yes    |
| `document.startViewTransition()`                 | yes      | yes               | yes    | yes    |
| `inert`                                          | yes      | yes               | yes    | yes    |
| `scrollIntoView({ container: 'nearest' })`       | yes      | yes               | **no** | **no** |

- `scrollIntoView({ container: 'nearest' })`: Safari and iOS ignore `container` and also scroll
  the outer scrollers.
- Per browser compatibility data, iOS 16.2 has none of `scrollend`, `ScrollTimeline`, or `animation-timeline: scroll()`. Keep the
  fallbacks for them while the minimum target is below the iOS version that added them.

## CSS `scroll-behavior: smooth`

- Under `scroll-behavior: smooth`, a `scrollTo()` without `behavior` animates. Verified: all four
  engines.
- A direct `scrollLeft` or `scrollTop` write also animates. A read right after the write returns
  the old value. To jump, use `scrollTo({ left, behavior: 'instant' })`. Verified: all four
  engines.
