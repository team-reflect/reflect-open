import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { MobileScreen } from '@/mobile/mobile-screen'
import type { AllNotesFilters } from '@/mobile/search-filters/filter-state'
import { BACK_SWIPE_SETTLE_MS, useBackSwipe, type BackSwipeState } from '@/mobile/use-back-swipe'
import { usePrefersReducedMotion } from '@/mobile/use-reduced-motion'
import type { Route } from '@/routing/route'
import { RouterFreeze, useRouter } from '@/routing/router'
import './mobile-stack.css'

/** Mirrors the animation durations in mobile-stack.css. */
const TRANSITION_MS = 350
const SETTLE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
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
 * Whether a route renders as a card pushed over a tab root. Only note
 * screens stack; everything else (daily, All, search-as-All) is a root.
 */
function isStacked(route: Route): boolean {
  return route.kind === 'note'
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
  swipe: BackSwipeState,
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
  if (swipe.phase === 'dragging') {
    return {
      style: {
        ...base,
        transform: `translate3d(${swipe.deltaX}px, 0, 0)`,
        willChange: 'transform',
      },
    }
  }
  if (swipe.phase === 'settling') {
    return {
      style: {
        ...base,
        transform: swipe.action === 'pop' ? 'translate3d(100%, 0, 0)' : 'translate3d(0, 0, 0)',
        transition: `transform ${BACK_SWIPE_SETTLE_MS}ms ${SETTLE_EASING}`,
        willChange: 'transform',
      },
    }
  }
  if (transition.kind === 'push') {
    return { className: 'mobile-stack-slide-in', style: { ...base, willChange: 'transform' } }
  }
  // Resting layers carry no transform at all: a transform would turn the
  // layer into the containing block for `position: fixed` descendants (the
  // daily screen's new-note button, floating editor UI) and shift them.
  return { style: base }
}

/**
 * The dim scrim over whatever a sliding card reveals. It sits above the
 * lower screen and below the moving card, fully dimmed while covered and
 * clearing as the card departs — depth without transforming the screen
 * underneath (see {@link presentLayer} on why roots must not transform).
 */
function presentScrim(transition: StackTransition, swipe: BackSwipeState): LayerPresentation {
  // During a pop the revealed screen IS the current layer (z 10), so the
  // scrim rises above it while staying under the exiting card (z 20).
  const zIndex = transition.kind === 'pop' ? 15 : 5
  if (swipe.phase === 'dragging') {
    return { style: { zIndex, opacity: Math.max(0, 1 - swipe.deltaX / swipe.width) } }
  }
  if (swipe.phase === 'settling') {
    return {
      style: {
        zIndex,
        opacity: swipe.action === 'pop' ? 0 : 1,
        transition: `opacity ${BACK_SWIPE_SETTLE_MS}ms ${SETTLE_EASING}`,
      },
    }
  }
  if (transition.kind === 'push') {
    return { className: 'mobile-stack-dim-in', style: { zIndex, opacity: 1 } }
  }
  if (transition.kind === 'pop') {
    return { className: 'mobile-stack-dim-out', style: { zIndex, opacity: 0 } }
  }
  return { style: { zIndex, opacity: 1 } }
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
 * typed-route history. A note screen is a card over its tab root — pushing
 * slides it in from the right, popping slides it out, and an edge back-swipe
 * drags it with the finger ({@link useBackSwipe}). The screen underneath
 * stays mounted (hidden and inert) while a card covers it, so a pop reveals
 * it live with scroll intact instead of remounting it — bounded to the one
 * screen `back()` would land on, never the whole history.
 *
 * Deliberately transform-based rather than the View Transitions API: view
 * transitions commit the DOM swap before animating, which would unmount the
 * editor at gesture start and remount it on a canceled swipe.
 */
export function MobileStack(props: MobileStackProps): ReactElement {
  const { route, entryId, backRoute, canBack, back, navigate } = useRouter()
  const reducedMotion = usePrefersReducedMotion()
  const containerRef = useRef<HTMLDivElement>(null)

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

  const swipe = useBackSwipe({
    enabled: isStacked(route) && transition.kind === 'none',
    reducedMotion,
    containerRef,
    onPop: () => {
      setPoppedByGesture(true)
      if (canBack) {
        back()
      } else {
        navigate({ kind: 'today' })
      }
    },
  })

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

  // Completion listeners live on the container as native listeners — React's
  // synthetic animation/transition events register vendor-detected names and
  // never fire in some hosts. Both events bubble; the class guard keeps
  // animations inside a screen (editor UI etc.) from ending a navigation.
  // Layers only, never the scrim: exactly one layer animates per transition,
  // so the layer's own end is the single source of truth — the scrim's
  // ending first must not cut the card's slide short.
  const { finishSettle } = swipe
  useEffect(() => {
    const node = containerRef.current
    if (!node) {
      return
    }
    const isStackLayer = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && target.classList.contains('mobile-stack-layer')
    const onAnimationEnd = (event: Event): void => {
      if (isStackLayer(event.target)) {
        finishTransition()
      }
    }
    const onTransitionEnd = (event: Event): void => {
      if (isStackLayer(event.target)) {
        finishSettle()
      }
    }
    node.addEventListener('animationend', onAnimationEnd)
    node.addEventListener('transitionend', onTransitionEnd)
    return () => {
      node.removeEventListener('animationend', onAnimationEnd)
      node.removeEventListener('transitionend', onTransitionEnd)
    }
  }, [finishTransition, finishSettle])

  const currentKey = layerKey(route)
  // What the back gesture reveals. A cold note entry has no history below
  // it, so it sits over today — where its back button lands too.
  const belowRoute: Route | null = isStacked(route) ? backRoute ?? { kind: 'today' } : null
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

  const showScrim = belowRoute !== null || transition.kind === 'pop'
  const scrim = showScrim ? presentScrim(transition, swipe.state) : null

  return (
    <div
      ref={containerRef}
      className="mobile-stack relative h-full overflow-hidden"
      {...swipe.handlers}
    >
      {layers.map((layer) => {
        const { className, style } = presentLayer(layer.role, layer.route, transition, swipe.state)
        const hidden = layer.role !== 'current'
        return (
          <div
            key={layer.key}
            className={`mobile-stack-layer absolute inset-0 bg-background ${className ?? ''}`}
            style={style}
            aria-hidden={hidden || undefined}
            inert={hidden}
          >
            {/* Background layers must not observe navigation: a push bumps
                arrivalSeq, which the daily surface under the note would read
                as a re-arrival and re-anchor its scroll while hidden. */}
            <RouterFreeze frozen={hidden}>
              <MobileScreen route={layer.route} {...props} />
            </RouterFreeze>
          </div>
        )
      })}
      {scrim ? (
        <div
          aria-hidden
          className={`mobile-stack-scrim pointer-events-none absolute inset-0 bg-black/25 ${scrim.className ?? ''}`}
          style={scrim.style}
        />
      ) : null}
    </div>
  )
}
