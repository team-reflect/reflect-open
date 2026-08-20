import { QueryClient } from '@tanstack/react-query'

type GraphRoot = string | undefined
type EntitlementProduct = 'yearly' | 'monthly'
type PaletteSearchMode = 'hybrid' | 'lexical'

/** The single source of truth for every TanStack Query cache identity. */
export const queryKeys = {
  index: {
    all: ['index'] as const,
    graph: (root: GraphRoot) => ['index', root] as const,
    allNotesPrefix: (root: GraphRoot) => ['index', root, 'all-notes'] as const,
    allNotes: (root: GraphRoot, foldedTag: string | null) =>
      ['index', root, 'all-notes', foldedTag] as const,
    allNotesTags: (root: GraphRoot) => ['index', root, 'all-notes-tags'] as const,
    paletteSuggestions: (
      root: GraphRoot,
      text: string,
      dateFormat: string,
      weekStartDay: string,
      today: string,
    ) => ['index', root, 'palette-suggest', text, dateFormat, weekStartDay, today] as const,
    paletteSearch: (root: GraphRoot, mode: PaletteSearchMode, text: string) =>
      ['index', root, 'palette-search', mode, text] as const,
    notePreview: (root: GraphRoot, path: string) => ['index', root, 'note-preview', path] as const,
    attendeeSuggestions: (root: GraphRoot, text: string, contacts: boolean) =>
      ['index', root, 'attendee-suggestions', text, contacts] as const,
    dailyDates: (root: GraphRoot, start: string, end: string) =>
      ['index', root, 'daily-dates', start, end] as const,
    conflictedNotes: (root: GraphRoot) => ['index', root, 'conflicted-notes'] as const,
    duplicateNoteIds: (root: GraphRoot) => ['index', root, 'duplicate-note-ids'] as const,
    templates: (root: GraphRoot) => ['index', root, 'templates'] as const,
    noteConflict: (root: GraphRoot, path: string) =>
      ['index', root, 'note-conflict', path] as const,
    noteConflictLabels: (root: GraphRoot, path: string) =>
      ['index', root, 'note-conflict-labels', path] as const,
    openTasks: (root: GraphRoot) => ['index', root, 'tasks'] as const,
    completedTasks: (root: GraphRoot) => ['index', root, 'tasks-completed'] as const,
    backlinks: (root: GraphRoot, path: string) => ['index', root, 'backlinks', path] as const,
    note: (root: GraphRoot, path: string) => ['index', root, 'note', path] as const,
    pinnedNotes: (root: GraphRoot) => ['index', root, 'pinned-notes'] as const,
    suggestedContact: (root: GraphRoot, path: string) =>
      ['index', root, 'suggested-contact', path] as const,
    dailyEmpty: (root: GraphRoot, path: string) => ['index', root, 'daily-empty', path] as const,
    mobileAllNotesPrefix: (root: GraphRoot) => ['index', root, 'mobile-all-notes'] as const,
    mobileAllNotes: <TSearch>(root: GraphRoot, search: TSearch) =>
      ['index', root, 'mobile-all-notes', search] as const,
    mobileNotePicker: (root: GraphRoot, text: string) =>
      ['index', root, 'mobile-note-picker', text] as const,
    mobileNoteCount: (root: GraphRoot) => ['index', root, 'mobile-note-count'] as const,
  },
  similar: {
    all: ['similar'] as const,
    note: (root: GraphRoot, path: string) => ['similar', root, path] as const,
  },
  chat: {
    all: ['chat'] as const,
    conversations: (root: GraphRoot) => ['chat', root, 'conversations'] as const,
  },
  settings: {
    current: ['settings'] as const,
  },
  calendar: {
    all: ['calendar'] as const,
    authorization: ['calendar', 'authorization'] as const,
    calendars: ['calendar', 'calendars'] as const,
    events: (date: string, calendarIds: readonly string[]) =>
      ['calendar', 'events', date, calendarIds] as const,
  },
  contacts: {
    authorization: ['contacts', 'authorization'] as const,
  },
  github: {
    authentication: ['github', 'authentication'] as const,
  },
  icloud: {
    all: ['icloud'] as const,
    status: ['icloud', 'status'] as const,
    pendingNotes: (root: GraphRoot) => ['icloud', root, 'pending-notes'] as const,
  },
  agentSkill: {
    all: ['agent-skill'] as const,
    status: (root: GraphRoot) => ['agent-skill', root, 'status'] as const,
  },
  iap: {
    all: ['iap'] as const,
    environment: ['iap', 'environment'] as const,
    products: ['iap', 'products'] as const,
    entitlements: ['iap', 'entitlement'] as const,
    entitlement: (product: EntitlementProduct) => ['iap', 'entitlement', product] as const,
  },
  mobile: {
    storage: ['mobile', 'storage'] as const,
  },
} as const

/** Stable identities for mutations that are observed outside their owning hook. */
export const mutationKeys = {
  tasks: {
    all: ['tasks'] as const,
    graph: (root: GraphRoot) => ['tasks', root] as const,
    complete: (root: GraphRoot) => ['tasks', root, 'complete'] as const,
    reopen: (root: GraphRoot) => ['tasks', root, 'reopen'] as const,
    delete: (root: GraphRoot) => ['tasks', root, 'delete'] as const,
    edit: (root: GraphRoot) => ['tasks', root, 'edit'] as const,
    schedule: (root: GraphRoot) => ['tasks', root, 'schedule'] as const,
    convert: (root: GraphRoot) => ['tasks', root, 'convert'] as const,
    editAndConvert: (root: GraphRoot) => ['tasks', root, 'edit-and-convert'] as const,
    insert: (root: GraphRoot) => ['tasks', root, 'insert'] as const,
    editAndToggle: (root: GraphRoot) => ['tasks', root, 'edit-and-toggle'] as const,
    checkboxToggle: (root: GraphRoot) => ['tasks', root, 'checkbox-toggle'] as const,
    contextInsert: (root: GraphRoot) => ['tasks', root, 'context-insert'] as const,
    snippetToggle: (root: GraphRoot) => ['tasks', root, 'snippet-toggle'] as const,
  },
  pinnedNotes: {
    reorder: (root: GraphRoot) => ['pinned-notes', root, 'reorder'] as const,
  },
  agentSkill: {
    write: (root: GraphRoot) => ['agent-skill', root, 'write'] as const,
  },
  iap: {
    purchase: ['iap', 'purchase'] as const,
    restore: ['iap', 'restore'] as const,
  },
  settings: {
    save: ['settings', 'save'] as const,
  },
} as const

export const mutationScopeIds = {
  pinnedNotesReorder: (root: string) => `pinned-notes:reorder:${root}`,
  agentSkillWrite: (root: string) => `agent-skill:write:${root}`,
  iapAction: 'iap:action',
  settingsSave: 'settings:save',
} as const

/**
 * The app's one TanStack Query client (adopted in Plan 07 per architecture
 * conventions §5): `queryFn`s are `@reflect/core` getters over the SQLite
 * projection, so index freshness is event-driven, not poll-driven — the graph
 * index lifecycle calls {@link invalidateIndexQueries} after rows actually
 * change (initial reconcile, then each applied watcher batch).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      retry: 1,
      refetchOnWindowFocus: false,
      networkMode: 'always',
    },
    mutations: {
      networkMode: 'always',
    },
  },
})

// SQLite projections and chat history are refreshed by explicit invalidation.
// Settings is hydrated once, then updated by its provider.
queryClient.setQueryDefaults(queryKeys.index.all, { staleTime: Infinity })
queryClient.setQueryDefaults(queryKeys.chat.all, { staleTime: Infinity })
queryClient.setQueryDefaults(queryKeys.settings.current, { staleTime: Infinity })

/** Refetch all index-backed queries; called after index rows change. */
export function invalidateIndexQueries(): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.index.all })
}

/**
 * Minimum spacing between full index-query refetch rounds on the batch
 * paths. During an initial iCloud sync the watch applies a batch every
 * couple of seconds for minutes; refetching every mounted index query per
 * batch is a large share of what makes a first sync feel slow.
 */
const INVALIDATE_THROTTLE_MS = 3_000

let lastInvalidateAt = 0
let invalidateTimer: ReturnType<typeof setTimeout> | null = null

/**
 * {@link invalidateIndexQueries} with leading+trailing throttling, for the
 * *streaming* callers (applied watcher batches, sweep/pull reindexes): an
 * isolated call fires immediately — a single save keeps its instant refresh
 * — while a burst collapses to one refetch per window, none dropped (the
 * trailing edge always runs). Direct user-action invalidations should keep
 * calling the unthrottled function.
 */
export function throttledInvalidateIndexQueries(): void {
  const now = Date.now()
  const elapsed = now - lastInvalidateAt
  if (elapsed >= INVALIDATE_THROTTLE_MS) {
    lastInvalidateAt = now
    invalidateIndexQueries()
    return
  }
  if (invalidateTimer !== null) {
    return // a trailing refetch is already on its way
  }
  invalidateTimer = setTimeout(() => {
    invalidateTimer = null
    lastInvalidateAt = Date.now()
    invalidateIndexQueries()
  }, INVALIDATE_THROTTLE_MS - elapsed)
}

/**
 * "Similar notes" results nest under this key — deliberately *outside*
 * `queryKeys.index`. Every other index-backed read is one cheap SQLite
 * query, so refetching the lot after any applied batch is fine; a neighbor
 * lookup is up to seventeen vector KNN queries (one per seed chunk), and under
 * the index scope it re-ran for changes it has nothing to do with — a remote
 * sync batch, a Git commit, an asset description, your own keystrokes in an
 * unrelated pane. With its own scope the panel computes once per note per
 * session, which is what it's for.
 *
 * Forget these cached neighbors on a graph switch. The graph root is part of
 * the key so stale rows could never be *read* after a switch, but these entries
 * are kept for the whole session and would otherwise never be collected.
 */
export function dropSimilarNotesQueries(): void {
  queryClient.removeQueries({ queryKey: queryKeys.similar.all })
}

/**
 * Forget the cached iCloud container listing after its contents change (a
 * graph delete trashes a container directory). Removal rather than
 * invalidation: with an invalidated cache the chooser would render the stale
 * list — deleted graph included — while the refetch runs.
 */
export function dropIcloudStatusQuery(): void {
  queryClient.removeQueries({ queryKey: queryKeys.icloud.status })
}

/** Refetch chat-history queries; called after a turn save or a delete. */
export function invalidateChatQueries(): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.chat.all })
}
