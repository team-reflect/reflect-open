import { useEffect, useRef, type RefObject } from 'react'

const PRELOAD_DISTANCE_PX = 600
const PRELOAD_MARGIN = `${PRELOAD_DISTANCE_PX}px 0px`
const SCROLLABLE_OVERFLOW = new Set(['auto', 'overlay', 'scroll'])

interface ViewportRegistration {
  readonly target: HTMLButtonElement
  readonly scrollRoot: HTMLElement | null
  readonly reveal: () => void
}

interface ScrollRootState {
  readonly observer: IntersectionObserver
  readonly targets: Set<HTMLButtonElement>
  readonly candidates: Set<HTMLButtonElement>
}

interface Bounds {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

interface RankedCandidate {
  readonly registration: ViewportRegistration
  readonly distance: number
}

const registrations = new Map<HTMLButtonElement, ViewportRegistration>()
const scrollRoots = new Map<HTMLElement | null, ScrollRootState>()
const scrollRootCache = new WeakMap<HTMLElement, HTMLElement | null>()
const visibleTargets = new Set<HTMLButtonElement>()
let visibilityObserver: IntersectionObserver | null = null
let visibilityObserverConstructor: typeof IntersectionObserver | null = null
let activationObserver: MutationObserver | null = null
let cancelScheduledReveal: (() => void) | null = null

function scheduleCallback(callback: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const frame = requestAnimationFrame(callback)
    return () => cancelAnimationFrame(frame)
  }

  const timeout = setTimeout(callback, 0)
  return () => clearTimeout(timeout)
}

function viewportBounds(): Bounds {
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
}

function visibleScrollRootBounds(scrollRoot: HTMLElement | null): Bounds | null {
  const viewport = viewportBounds()
  if (scrollRoot === null) {
    return viewport
  }

  const root = scrollRoot.getBoundingClientRect()
  const left = Math.max(root.left, viewport.left)
  const top = Math.max(root.top, viewport.top)
  const right = Math.min(root.right, viewport.right)
  const bottom = Math.min(root.bottom, viewport.bottom)
  if (right <= left || bottom <= top) {
    return null
  }
  return { left, top, right, bottom }
}

function candidateDistance(target: HTMLButtonElement, root: Bounds): number | null {
  const bounds = target.getBoundingClientRect()
  if (bounds.right < root.left || bounds.left > root.right) {
    return null
  }
  if (
    bounds.bottom < root.top - PRELOAD_DISTANCE_PX ||
    bounds.top > root.bottom + PRELOAD_DISTANCE_PX
  ) {
    return null
  }
  if (bounds.bottom >= root.top && bounds.top <= root.bottom) {
    return 0
  }
  return bounds.bottom < root.top ? root.top - bounds.bottom : bounds.top - root.bottom
}

function nearestCandidate(): RankedCandidate | null {
  let nearest: RankedCandidate | null = null
  for (const [scrollRoot, state] of scrollRoots) {
    const root = visibleScrollRootBounds(scrollRoot)
    if (root === null) {
      continue
    }
    for (const target of state.candidates) {
      if (target.closest('[inert], [aria-hidden="true"]') !== null) {
        continue
      }
      const registration = registrations.get(target)
      if (registration === undefined) {
        state.candidates.delete(target)
        continue
      }
      const distance = candidateDistance(target, root)
      if (distance === null) {
        // Intersection callbacks are asynchronous after layout. Drop a stale
        // candidate now; its root observer will add it again when it returns.
        state.candidates.delete(target)
        continue
      }
      const rankedDistance = visibleTargets.has(target) ? -1 : distance
      if (nearest === null || rankedDistance < nearest.distance) {
        nearest = { registration, distance: rankedDistance }
      }
    }
  }
  return nearest
}

function scheduleReveal(): void {
  if (cancelScheduledReveal !== null) {
    return
  }
  cancelScheduledReveal = scheduleCallback(flushReveal)
}

function flushReveal(): void {
  cancelScheduledReveal = null
  const next = nearestCandidate()
  if (next === null) {
    return
  }

  unregister(next.registration)
  next.registration.reveal()

  // The new Markdown can move every remaining candidate. Wait a frame, then
  // rank the observer's near-set against fresh geometry again.
  if (registrations.size > 0) {
    scheduleReveal()
  }
}

function nearestScrollRoot(target: HTMLElement): HTMLElement | null {
  let parent = target.parentElement
  const visited: HTMLElement[] = []
  while (parent !== null) {
    if (scrollRootCache.has(parent)) {
      const cached = scrollRootCache.get(parent) ?? null
      for (const element of visited) {
        scrollRootCache.set(element, cached)
      }
      return cached
    }
    visited.push(parent)
    const style = getComputedStyle(parent)
    if (
      SCROLLABLE_OVERFLOW.has(style.overflowY) ||
      SCROLLABLE_OVERFLOW.has(style.overflow)
    ) {
      for (const element of visited) {
        scrollRootCache.set(element, parent)
      }
      return parent
    }
    parent = parent.parentElement
  }
  for (const element of visited) {
    scrollRootCache.set(element, null)
  }
  return null
}

function getScrollRootState(scrollRoot: HTMLElement | null): ScrollRootState {
  const existing = scrollRoots.get(scrollRoot)
  if (existing !== undefined) {
    return existing
  }

  let state: ScrollRootState
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const target = entry.target
        if (!(target instanceof HTMLButtonElement)) {
          continue
        }
        if (entry.isIntersecting) {
          state.candidates.add(target)
        } else {
          state.candidates.delete(target)
        }
      }
      if (state.candidates.size > 0) {
        scheduleReveal()
      }
    },
    { root: scrollRoot, rootMargin: PRELOAD_MARGIN },
  )
  state = {
    observer,
    targets: new Set<HTMLButtonElement>(),
    candidates: new Set<HTMLButtonElement>(),
  }
  scrollRoots.set(scrollRoot, state)
  return state
}

function getVisibilityObserver(): IntersectionObserver {
  if (visibilityObserverConstructor !== IntersectionObserver) {
    visibilityObserver?.disconnect()
    visibilityObserverConstructor = IntersectionObserver
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target
        if (!(target instanceof HTMLButtonElement)) {
          continue
        }
        if (entry.isIntersecting) {
          visibleTargets.add(target)
        } else {
          visibleTargets.delete(target)
        }
      }
      scheduleReveal()
    })
    visibilityObserver = observer
    return observer
  }
  if (visibilityObserver === null) {
    throw new Error('visibility observer was not initialized')
  }
  return visibilityObserver
}

function observeActivationChanges(): void {
  if (typeof MutationObserver === 'undefined') {
    return
  }
  activationObserver ??= new MutationObserver(scheduleReveal)
  activationObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['aria-hidden', 'inert'],
    subtree: true,
  })
}

function unregister(registration: ViewportRegistration): void {
  if (registrations.get(registration.target) !== registration) {
    return
  }
  registrations.delete(registration.target)
  visibleTargets.delete(registration.target)
  visibilityObserver?.unobserve(registration.target)

  const state = scrollRoots.get(registration.scrollRoot)
  state?.observer.unobserve(registration.target)
  state?.targets.delete(registration.target)
  state?.candidates.delete(registration.target)
  if (state?.targets.size === 0) {
    state.observer.disconnect()
    scrollRoots.delete(registration.scrollRoot)
  }

  if (registrations.size === 0) {
    cancelScheduledReveal?.()
    cancelScheduledReveal = null
    activationObserver?.disconnect()
  }
}

function register(target: HTMLButtonElement, reveal: () => void): () => void {
  const registration: ViewportRegistration = {
    target,
    scrollRoot: nearestScrollRoot(target),
    reveal,
  }
  registrations.set(target, registration)

  const state = getScrollRootState(registration.scrollRoot)
  state.targets.add(target)
  state.observer.observe(target)
  getVisibilityObserver().observe(target)
  observeActivationChanges()
  return () => unregister(registration)
}

/**
 * Reveal one lightweight placeholder shortly before it reaches its real note
 * scroller. Observers pool near-targets by scroll root, then a shared scheduler
 * reveals at most one best candidate per frame: actually visible references
 * first, followed by the closest preloaded reference. Geometry is revalidated
 * after every Markdown mount so layout shifts cannot leave stale work queued.
 */
export function useNearViewport(
  enabled: boolean,
  reveal: () => void,
): RefObject<HTMLButtonElement | null> {
  const targetRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const target = targetRef.current
    if (!enabled || target === null) {
      return
    }
    return register(target, reveal)
  }, [enabled, reveal])

  return targetRef
}
