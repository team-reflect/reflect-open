import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'
import { cn } from '@/lib/utils.ts'
import { MobileScreen } from '@/mobile/mobile-screen.tsx'
import type { AllNotesFilters, Route } from '@reflect/app'
import { useBackPager } from '@/mobile/use-back-pager.ts'
import { usePrefersReducedMotion } from '@/mobile/use-reduced-motion.ts'
import { RouterFreeze, useRouter } from '@/routing/router.tsx'
import './mobile-stack.css'

/** Mirrors the animation durations in mobile-stack.css. */
const TRANSITION_MS = 350
/** The stacked card's leading-edge shadow, visible while it slides. */
const CARD_SHADOW = '-8px 0 24px rgb(0 0 0 / 0.18)'

type StackTransition =
  | { kind: 'none' }
  | { kind: 'push' }
  | { kind: 'pop'; exiting: { key: string; route: Route } }

type LayerRole = 'below' | 'current' | 'exiting'

interface StackLayer {
  key: string
  route: Route
  role: LayerRole
}

/**
 * Whether a route renders as a card pushed over a tab root. Note screens and
 * the settings screens (Settings, its Graphs sub-screen) stack; everything
 * else (daily, All, search-as-All) is a root.
 */
function isStacked(route: Route): boolean {
  return (
    route.kind === 'note' ||
    route.kind === 'settings' ||
    route.kind === 'graphs' ||
    route.kind === 'licenses'
  )
}

/**
 * The mounted identity of a route's screen. Mirrors the keys MobileScreen's
 * switch has always used: one persistent daily surface (a day change scrolls
 * the carousel instead of remounting it), one All surface, one screen per
 * note path.
 */
function layerKey(route: Route): string {
  switch (route.kind) {
    case 'note':
      return `note:${route.path}`
    case 'settings':
      return 'settings'
    case 'graphs':
      return 'graphs'
    case 'licenses':
      return 'licenses'
    case 'allNotes':
    case 'search':
      return 'all'
    default:
      return 'daily'
  }
}

/**
 * The animation an arrival deserves, V1 semantics: entering the note stack
 * slides in, leaving it slides out, moving within it follows history order,
 * and root-to-root moves (tab switches, date links) stay instant.
 */
function transitionFor(
  from: { route: Route; entryId: number },
  to: { route: Route; entryId: number },
): StackTransition {
  const fromStacked = isStacked(from.route)
  const toStacked = isStacked(to.route)
  const pop: StackTransition = {
    kind: 'pop',
    exiting: { key: layerKey(from.route), route: from.route },
  }
  if (toStacked && !fromStacked) {
    return { kind: 'push' }
  }
  if (!toStacked && fromStacked) {
    return pop
  }
  if (toStacked && fromStacked) {
    // Note to note: entry ids grow monotonically, so a smaller id means the
    // arrival walked back down the history stack.
    return to.entryId > from.entryId ? { kind: 'push' } : pop
  }
  return { kind: 'none' }
}

interface LayerPresentation {
  className?: string
  style: CSSProperties
}

function presentLayer(
  role: LayerRole,
  layerRoute: Route,
  transition: StackTransition,
): LayerPresentation {
  const shadow = isStacked(layerRoute) ? CARD_SHADOW : undefined
  if (role === 'below') {
    return { style: { zIndex: 0 } }
  }
  if (role === 'exiting') {
    return {
      className: 'mobile-stack-slide-out',
      style: {
        transform: 'translate3d(100%, 0, 0)',
        zIndex: 20,
        boxShadow: shadow,
        willChange: 'transform',
      },
    }
  }
  const base: CSSProperties = { zIndex: 10, boxShadow: shadow }
  if (transition.kind === 'push') {
    return { className: 'mobile-stack-slide-in', style: { ...base, willChange: 'transform' } }
  }
  // Resting layers carry no transform at all: a transform would turn the
  // layer into the containing block for `position: fixed` descendants (the
  // daily screen's capture menu) and shift them. The finger moves a layer by
  // scrolling the pager instead.
  return { style: base }
}

const STRIP_CONTROLS = 'button, a, [role="button"], label'
const STRIP_FIELDS = 'input, textarea, select'

/**
 * Hands a tap on the back-swipe edge strip to what lies under it on the same
 * page, so the strip only takes horizontal drags.
 */
function forwardStripTap(event: ReactMouseEvent<HTMLElement>): void {
  const strip = event.currentTarget
  const page = strip.parentElement
  const { clientX, clientY } = event
  // Hit tests see through the strip only while it ignores pointers.
  strip.style.pointerEvents = 'none'
  const target = document
    .elementsFromPoint(clientX, clientY)
    .find((element) => page?.contains(element) ?? false)
  const caret = document.caretRangeFromPoint(clientX, clientY)
  strip.style.removeProperty('pointer-events')
  if (!(target instanceof HTMLElement)) {
    return
  }
  const field = target.closest<HTMLElement>(STRIP_FIELDS)
  if (field) {
    field.focus()
    return
  }
  const control = target.closest<HTMLElement>(STRIP_CONTROLS)
  if (control) {
    control.click()
    return
  }
  const editable = target.closest<HTMLElement>('[contenteditable="true"]')
  if (editable && caret && editable.contains(caret.startContainer)) {
    editable.focus({ preventScroll: true })
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(caret)
  }
}

/**
 * The dim scrim over what a push or pop animation reveals. It sits above the
 * lower screen and below the moving card, fully dimmed while covered and
 * clearing as the card departs: depth without transforming the screen
 * underneath (see {@link presentLayer} on why layers must not transform).
 */
function presentScrim(transition: StackTransition): LayerPresentation {
  // During a pop the revealed screen IS the current layer (z 10), so the
  // scrim rises above it while staying under the exiting card (z 20).
  if (transition.kind === 'pop') {
    return { className: 'mobile-stack-dim-out', style: { zIndex: 15, opacity: 0 } }
  }
  return { className: 'mobile-stack-dim-in', style: { zIndex: 5, opacity: 1 } }
}

interface MobileStackProps {
  /** The All tab's search text (owned by the shell — survives navigation). */
  allQuery: string
  onAllQueryChange: (query: string) => void
  /** The All tab's badge filters (owned by the shell — survive navigation). */
  allFilters: AllNotesFilters
  onAllFiltersChange: (filters: AllNotesFilters) => void
}

/**
 * The mobile navigation stack: V1's native-feeling push/pop restored over the
 * typed-route history. A note screen is a card over its tab root: pushing
 * slides it in from the right and popping slides it out, both as CSS
 * keyframes. The screen underneath stays mounted (hidden and inert) while a
 * card covers it, so a pop reveals it live with scroll intact instead of
 * remounting it, bounded to the one screen `back()` would land on.
 *
 * The layers are pages of a horizontal scroll-snap pager, each sticky at the
 * left edge with the current one last. An edge back-swipe is a native scroll
 * of that pager ({@link useBackPager}): the browser moves the card with the
 * finger and snaps it home or off, so the drag never waits for the main
 * thread. Stacked screens pan only vertically (`.mobile-pager-content` in
 * index.css); a strip along the card's left edge takes the horizontal drag,
 * by finger or by mouse, and hands taps to what lies under it. A horizontal scroller inside a
 * stacked screen needs `data-pager-pan-x`.
 *
 * A stacked screen must not hold a `position: fixed` element: it stays put
 * while the card moves. Put floating UI in a portal or the top layer.
 *
 * Deliberately not the View Transitions API: view transitions commit the DOM
 * swap before animating, which would unmount the editor at gesture start and
 * remount it on a canceled swipe.
 */
export function MobileStack(props: MobileStackProps): ReactElement {
  const { route, entryId, backRoute, canBack, back, navigate } = useRouter()
  const reducedMotion = usePrefersReducedMotion()
  const containerRef = useRef<HTMLDivElement>(null)
  const pagerRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const edgeRef = useRef<HTMLDivElement>(null)

  const [transition, setTransition] = useState<StackTransition>({ kind: 'none' })
  const [arrival, setArrival] = useState({ route, entryId })
  // Set when a completed back-swipe commits its pop: the screen is already
  // offscreen, so the arrival it causes must not animate a second time.
  const [poppedByGesture, setPoppedByGesture] = useState(false)

  // Transition detection happens during render (the mobile-shell `lastTab`
  // pattern) so the new screen's very first frame starts offscreen.
  if (entryId !== arrival.entryId) {
    setArrival({ route, entryId })
    setPoppedByGesture(false)
    setTransition(
      poppedByGesture || reducedMotion
        ? { kind: 'none' }
        : transitionFor(arrival, { route, entryId }),
    )
  } else if (route !== arrival.route) {
    // Same entry, new route object: a note move rewrote the history in
    // place. Track it so a later pop's exiting card shows the live path.
    setArrival({ route, entryId })
  }

  const popByGesture = useCallback((): void => {
    setPoppedByGesture(true)
    if (canBack) {
      back()
    } else {
      navigate({ kind: 'today' })
    }
  }, [canBack, back, navigate])

  const finishTransition = useCallback((): void => {
    setTransition((current) => (current.kind === 'none' ? current : { kind: 'none' }))
  }, [])

  // `animationend` is the fast path; this backstops a missed event.
  useEffect(() => {
    if (transition.kind === 'none') {
      return
    }
    const timer = setTimeout(finishTransition, TRANSITION_MS + 80)
    return () => clearTimeout(timer)
  }, [transition, finishTransition])

  // The completion listener lives on the container as a native listener:
  // React's synthetic animation events register vendor-detected names and
  // never fire in some hosts. The event bubbles; the class guard keeps
  // animations inside a screen (editor UI etc.) from ending a navigation.
  // Layers only, never the scrim: exactly one layer animates per transition,
  // so the layer's own end is the single source of truth, and the scrim's
  // ending first must not cut the card's slide short.
  useEffect(() => {
    const node = containerRef.current
    if (!node) {
      return
    }
    const controller = new AbortController()
    node.addEventListener(
      'animationend',
      (event) => {
        const { target } = event
        if (target instanceof HTMLElement && target.classList.contains('mobile-stack-layer')) {
          finishTransition()
        }
      },
      { signal: controller.signal },
    )
    return () => controller.abort()
  }, [finishTransition])

  const currentKey = layerKey(route)
  // What the back gesture reveals. A cold note entry has no history below
  // it, so it sits over today, where its back button lands too.
  const belowRoute: Route | null = isStacked(route) ? (backRoute ?? { kind: 'today' }) : null
  const belowKey = belowRoute === null ? null : layerKey(belowRoute)

  const layers: StackLayer[] = []
  if (belowRoute !== null && belowKey !== null && belowKey !== currentKey) {
    layers.push({ key: belowKey, route: belowRoute, role: 'below' })
  }
  layers.push({ key: currentKey, route, role: 'current' })
  if (
    transition.kind === 'pop' &&
    transition.exiting.key !== currentKey &&
    transition.exiting.key !== belowKey
  ) {
    layers.push({ key: transition.exiting.key, route: transition.exiting.route, role: 'exiting' })
  }

  const swipeEnabled =
    isStacked(route) && transition.kind === 'none' && layers.some((layer) => layer.role === 'below')

  useBackPager({
    scrollerRef: pagerRef,
    scrimRef,
    edgeRef,
    pageCount: layers.length,
    pagesKey: layers.map((layer) => layer.key).join('|'),
    enabled: swipeEnabled,
    onPop: popByGesture,
  })

  const transitionScrim = transition.kind === 'none' ? null : presentScrim(transition)

  return (
    <div ref={containerRef} className="mobile-stack relative h-full overflow-hidden">
      <div
        ref={pagerRef}
        className={cn(
          'mobile-pager relative flex h-full snap-x snap-mandatory scrollbar-none overflow-y-hidden overscroll-none',
          swipeEnabled ? 'overflow-x-auto' : 'overflow-x-hidden',
        )}
      >
        {layers.map((layer) => {
          const { className, style } = presentLayer(layer.role, layer.route, transition)
          const hidden = layer.role !== 'current'
          return (
            <div
              key={layer.key}
              className={cn(
                'mobile-stack-layer sticky left-0 h-full w-full shrink-0 bg-background',
                className,
              )}
              style={style}
              data-stack-role={layer.role}
              aria-hidden={hidden || undefined}
              inert={hidden}
            >
              <div className={cn('h-full', isStacked(layer.route) && 'mobile-pager-content')}>
                {/* Background layers must not observe navigation: a push bumps
                    arrivalSeq, which the daily surface under the note would read
                    as a re-arrival and re-anchor its scroll while hidden. */}
                <RouterFreeze frozen={hidden}>
                  <MobileScreen route={layer.route} {...props} />
                </RouterFreeze>
              </div>
              {swipeEnabled && !hidden ? (
                <>
                  <div
                    ref={scrimRef}
                    aria-hidden
                    className="mobile-pager-scrim pointer-events-none absolute inset-y-0 right-full w-full bg-black/25"
                  />
                  <div
                    ref={edgeRef}
                    aria-hidden
                    data-pager-edge
                    className="absolute inset-y-0 left-0 z-10 w-5 touch-pan-x select-none"
                    onClick={forwardStripTap}
                  />
                </>
              ) : null}
            </div>
          )
        })}
        {layers.map((layer, index) => (
          <div
            key={`snap:${layer.key}`}
            aria-hidden
            className="pointer-events-none absolute top-0 size-px snap-start"
            style={{ left: `${index * 100}%` }}
          />
        ))}
      </div>
      {transitionScrim ? (
        <div
          aria-hidden
          className={cn(
            'mobile-stack-scrim pointer-events-none absolute inset-0 bg-black/25',
            transitionScrim.className,
          )}
          style={transitionScrim.style}
        />
      ) : null}
    </div>
  )
}
