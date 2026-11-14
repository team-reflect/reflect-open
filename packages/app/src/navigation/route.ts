/**
 * Typed product routes (Plan 06). These are app states, not page names — the
 * integration point for navigation, back/forward history, and later deep links
 * and CLI `open` (Plan 14).
 *
 * Note identity is the graph-relative path in the first wave (Plan 03), so the
 * note route carries `path` — the reserved frontmatter `id` can join it later
 * without breaking the shape.
 */
import { returnNull } from '@ocavue/utils'
import { isIsoDate } from '@reflect/utils'
import {
  DEEP_LINK_SCHEME,
  dailyDeepLink,
  dailyPath,
  dateFromDailyPath,
  isDaily,
  noteDeepLink,
} from '@reflect/core'
import { z } from 'zod'

/**
 * Parses a route that was stored as JSON.
 */
export const routeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('today') }),
  z.object({ kind: z.literal('daily'), date: z.string() }),
  z.object({ kind: z.literal('note'), path: z.string() }),
  z.object({ kind: z.literal('allNotes'), tag: z.string().nullable() }),
  z.object({ kind: z.literal('search'), query: z.string() }),
  z.object({ kind: z.literal('tasks') }),
  // `conversationId` names the conversation the entry shows; `null` (the
  // Chat button, ⌘J) stands for the conversation the chat session has open.
  z.object({ kind: z.literal('chat'), conversationId: z.string().nullable().default(null) }),
  // `graphs` (the graph switcher) and `licenses` (Open Source Licenses) are
  // mobile sub-screens of Settings. Desktop renders every page as the
  // settings screen: its graph switcher lives in the sidebar footer and its
  // licenses in a dialog.
  z.object({ kind: z.literal('settings'), page: z.enum(['main', 'graphs', 'licenses']) }),
])

export type Route = z.infer<typeof routeSchema>

/**
 * Parses a section that was stored as JSON.
 */
export const sectionSchema = z.enum(['daily', 'all', 'tasks', 'chat'])

/**
 * A top-level area of the app. Every history entry belongs to one section.
 */
export type Section = z.infer<typeof sectionSchema>

type RouteOf<K extends Route['kind']> = Extract<Route, { kind: K }>

/**
 * What the navigation layers need to know about one route kind.
 */
export interface RouteMeta<R extends Route> {
  /**
   * The section whose root screen the route shows, or `null` for a screen
   * that opens over the current section (a note, the settings screens).
   */
  readonly section: Section | null
  /**
   * The scroll surface that every entry of this kind shares, or `null` for
   * per-entry scroll. Today and dated daily routes share one stream.
   */
  readonly scrollSurface: string | null
  /**
   * The screen under the route when no history is below it, where its Back
   * lands too.
   */
  readonly parent: (route: R) => Route
  /**
   * The deep link that addresses the route, or `null` for an in-app surface
   * that the deep-link grammar does not name.
   */
  readonly deepLink: (route: R) => string | null
}

const today = (): Route => ({ kind: 'today' })

/**
 * The metadata of every route kind, in one place.
 */
export const ROUTE_META: { readonly [K in Route['kind']]: RouteMeta<RouteOf<K>> } = {
  today: {
    section: 'daily',
    scrollSurface: 'daily',
    parent: today,
    deepLink: () => `${DEEP_LINK_SCHEME}://today`,
  },
  daily: {
    section: 'daily',
    scrollSurface: 'daily',
    parent: today,
    deepLink: (route) => dailyDeepLink(route.date),
  },
  note: {
    section: null,
    scrollSurface: null,
    parent: today,
    deepLink: (route) => noteDeepLink(route.path),
  },
  allNotes: { section: 'all', scrollSurface: null, parent: today, deepLink: returnNull },
  search: {
    section: 'all',
    scrollSurface: null,
    parent: today,
    deepLink: (route) => `${DEEP_LINK_SCHEME}://search?q=${encodeURIComponent(route.query)}`,
  },
  tasks: {
    section: 'tasks',
    scrollSurface: null,
    parent: today,
    deepLink: () => `${DEEP_LINK_SCHEME}://tasks`,
  },
  chat: { section: 'chat', scrollSurface: null, parent: today, deepLink: returnNull },
  settings: {
    section: null,
    scrollSurface: null,
    parent: (route) => {
      return route.page === 'main' ? { kind: 'today' } : { kind: 'settings', page: 'main' }
    },
    deepLink: returnNull,
  },
}

/**
 * The metadata of `route`'s kind, typed for `route`.
 */
export function routeMeta<R extends Route>(route: R): RouteMeta<R> {
  return ROUTE_META[route.kind] as unknown as RouteMeta<R>
}

/**
 * The section whose root screen `route` shows, or `null` for a route that
 * opens over the current section (a note, the settings screens).
 */
export function rootSectionForRoute(route: Route): Section | null {
  return ROUTE_META[route.kind].section
}

/**
 * A route that addresses one concrete note, including a dated daily note.
 */
export type NoteRoute = Extract<Route, { kind: 'daily' | 'note' }>

/**
 * Structural route equality (used to avoid pushing no-op history entries).
 * Every route is a flat object of primitives.
 */
export function routesEqual(a: Route, b: Route): boolean {
  const aFields = Object.entries(a)
  return (
    aFields.length === Object.keys(b).length &&
    aFields.every(([key, value]) => (b as Record<string, unknown>)[key] === value)
  )
}

/**
 * The route a resolved note path navigates to: a real-calendar daily date opens
 * the daily view; anything else — including a `daily/…` file whose name is a
 * well-formed but impossible date (e.g. `2026-02-31`), which `dailyPath` would
 * reject — opens as a plain note so navigation can never crash the workspace.
 */
export function routeForPath(path: string): NoteRoute {
  const date = isDaily(path) ? dateFromDailyPath(path) : null
  return date !== null && isIsoDate(date) ? { kind: 'daily', date } : { kind: 'note', path }
}

/**
 * The daily date a route is anchored on: today's date for the `today` route
 * (hence the `today` parameter), the route's own date for `daily/:date`, and
 * null for any route that isn't a daily view (notes, search, chat, settings).
 */
function dailyDateForRoute(route: Route, today: string): string | null {
  switch (route.kind) {
    case 'today':
      return today
    case 'daily':
      return route.date
    default:
      return null
  }
}

/**
 * The daily date the user is *effectively* working on: the day focused in the
 * daily stream when there is one, otherwise the route's own daily date. Null
 * when the route isn't a daily view, where the focused day is irrelevant.
 *
 * The stream keeps a single `daily/:date` route as focus moves between days, so
 * the focused day — not the routed one — is what both the context sidebar and
 * note-scoped commands must point at. This is the one place that precedence
 * lives, so those two surfaces can never disagree about which day they target.
 */
export function effectiveDailyDate(
  route: Route,
  today: string,
  focusedDailyDate: string | null,
): string | null {
  const routed = dailyDateForRoute(route, today)
  return routed === null ? null : (focusedDailyDate ?? routed)
}

/**
 * The note file a route is editing — what note-scoped commands (pin, …) act
 * on: a note route's path, a daily route's file (today's for the `today`
 * route), and null for screens that edit no note (search, chat, settings).
 */
export function notePathForRoute(route: Route, today: string): string | null {
  if (route.kind === 'note') {
    return route.path
  }
  const daily = dailyDateForRoute(route, today)
  return daily === null ? null : dailyPath(daily)
}

/**
 * The note file the user is currently working in. Daily views resolve through
 * the focused stream day; all other routes use their directly addressed note.
 * This is the shared target for note-scoped commands and transient note chrome
 * such as Find, so neither can drift to a different virtualized day.
 */
export function focusedNotePathForRoute(
  route: Route,
  today: string,
  focusedDailyDate: string | null,
): string | null {
  const daily = effectiveDailyDate(route, today, focusedDailyDate)
  return daily !== null ? dailyPath(daily) : notePathForRoute(route, today)
}

/**
 * The invariant the router maintains on every entry: a `daily` route never
 * carries an impossible calendar date past the boundary (`dailyPath` would
 * throw on one downstream). A malformed date collapses to the `today` route —
 * the same anchoring the stream would choose — so views consuming
 * the router can trust `route.date` without re-validating it.
 */
export function normalizeRoute(route: Route): Route {
  return route.kind === 'daily' && !isIsoDate(route.date) ? { kind: 'today' } : route
}
