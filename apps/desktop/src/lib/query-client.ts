import { QueryClient } from '@tanstack/react-query'

type GraphRoot = string | undefined
type PaletteSearchMode = 'hybrid' | 'lexical'

/** The single source of truth for every TanStack Query cache identity. */
export const queryKeys = {
  index: {
    all: ['index'] as const,
    graph(root: GraphRoot) {
      return [...this.all, root] as const
    },
    allNotes(root: GraphRoot) {
      return [...this.graph(root), 'all-notes'] as const
    },
    allNotesWithTag(root: GraphRoot, foldedTag: string | null) {
      return [...this.allNotes(root), 'tag', foldedTag] as const
    },
    allNotesTags(root: GraphRoot) {
      return [...this.graph(root), 'all-notes-tags'] as const
    },
    paletteSuggestions(
      root: GraphRoot,
      options: { text: string; dateFormat: string; weekStartDay: string; today: string },
    ) {
      return [
        ...this.graph(root),
        'palette-suggest',
        options.text,
        options.dateFormat,
        options.weekStartDay,
        options.today,
      ] as const
    },
    paletteSearch(root: GraphRoot, mode: PaletteSearchMode, text: string) {
      return [...this.graph(root), 'palette-search', mode, text] as const
    },
    notePreview(root: GraphRoot, path: string) {
      return [...this.graph(root), 'note-preview', path] as const
    },
    attendeeSuggestions(root: GraphRoot, text: string, contacts: boolean) {
      return [...this.graph(root), 'attendee-suggestions', text, contacts] as const
    },
    dailyDates(root: GraphRoot, start: string, end: string) {
      return [...this.graph(root), 'daily-dates', start, end] as const
    },
    conflictedNotes(root: GraphRoot) {
      return [...this.graph(root), 'conflicted-notes'] as const
    },
    duplicateNoteIds(root: GraphRoot) {
      return [...this.graph(root), 'duplicate-note-ids'] as const
    },
    templates(root: GraphRoot) {
      return [...this.graph(root), 'templates'] as const
    },
    noteConflict(root: GraphRoot, path: string) {
      return [...this.graph(root), 'note-conflict', path] as const
    },
    noteConflictLabels(root: GraphRoot, path: string) {
      return [...this.graph(root), 'note-conflict-labels', path] as const
    },
    openTasks(root: GraphRoot) {
      return [...this.graph(root), 'tasks'] as const
    },
    completedTasks(root: GraphRoot) {
      return [...this.graph(root), 'tasks-completed'] as const
    },
    backlinks(root: GraphRoot, path: string) {
      return [...this.graph(root), 'backlinks', path] as const
    },
    note(root: GraphRoot, path: string) {
      return [...this.graph(root), 'note', path] as const
    },
    pinnedNotes(root: GraphRoot) {
      return [...this.graph(root), 'pinned-notes'] as const
    },
    suggestedContact(root: GraphRoot, path: string) {
      return [...this.graph(root), 'suggested-contact', path] as const
    },
    dailyEmpty(root: GraphRoot, path: string) {
      return [...this.graph(root), 'daily-empty', path] as const
    },
    mobileAllNotes(root: GraphRoot) {
      return [...this.graph(root), 'mobile-all-notes'] as const
    },
    mobileAllNotesWithSearch<TSearch>(root: GraphRoot, search: TSearch) {
      return [...this.mobileAllNotes(root), search] as const
    },
    mobileNotePicker(root: GraphRoot, text: string) {
      return [...this.graph(root), 'mobile-note-picker', text] as const
    },
    mobileNoteCount(root: GraphRoot) {
      return [...this.graph(root), 'mobile-note-count'] as const
    },
  },
  similar: {
    all: ['similar'] as const,
    note(root: GraphRoot, path: string) {
      return [...this.all, root, path] as const
    },
  },
  chat: {
    all: ['chat'] as const,
    conversations(root: GraphRoot) {
      return [...this.all, root, 'conversations'] as const
    },
  },
  settings: {
    all: ['settings'] as const,
  },
  calendar: {
    all: ['calendar'] as const,
    get authorization() {
      return [...this.all, 'authorization'] as const
    },
    get calendars() {
      return [...this.all, 'calendars'] as const
    },
    events(date: string, calendarIds: readonly string[]) {
      return [...this.all, 'events', date, calendarIds] as const
    },
  },
  contacts: {
    all: ['contacts'] as const,
    get authorization() {
      return [...this.all, 'authorization'] as const
    },
  },
  github: {
    all: ['github'] as const,
    get authentication() {
      return [...this.all, 'authentication'] as const
    },
  },
  icloud: {
    all: ['icloud'] as const,
    get status() {
      return [...this.all, 'status'] as const
    },
    pendingNotes(root: GraphRoot) {
      return [...this.all, root, 'pending-notes'] as const
    },
  },
  agentSkill: {
    all: ['agent-skill'] as const,
    status(root: GraphRoot) {
      return [...this.all, root, 'status'] as const
    },
  },
  appStore: {
    all: ['app-store'] as const,
    get environment() {
      return [...this.all, 'environment'] as const
    },
  },
  iap: {
    all: ['iap'] as const,
    get products() {
      return [...this.all, 'products'] as const
    },
    get entitlements() {
      return [...this.all, 'entitlement'] as const
    },
  },
  mobile: {
    all: ['mobile'] as const,
    get storage() {
      return [...this.all, 'storage'] as const
    },
  },
} as const

/** Stable identities for mutations that are observed outside their owning hook. */
export const mutationKeys = {
  tasks: {
    all: ['tasks'] as const,
    graph(root: GraphRoot) {
      return [...this.all, root] as const
    },
    complete(root: GraphRoot) {
      return [...this.graph(root), 'complete'] as const
    },
    reopen(root: GraphRoot) {
      return [...this.graph(root), 'reopen'] as const
    },
    delete(root: GraphRoot) {
      return [...this.graph(root), 'delete'] as const
    },
    edit(root: GraphRoot) {
      return [...this.graph(root), 'edit'] as const
    },
    schedule(root: GraphRoot) {
      return [...this.graph(root), 'schedule'] as const
    },
    convert(root: GraphRoot) {
      return [...this.graph(root), 'convert'] as const
    },
    editAndConvert(root: GraphRoot) {
      return [...this.graph(root), 'edit-and-convert'] as const
    },
    insert(root: GraphRoot) {
      return [...this.graph(root), 'insert'] as const
    },
    editAndToggle(root: GraphRoot) {
      return [...this.graph(root), 'edit-and-toggle'] as const
    },
    checkboxToggle(root: GraphRoot) {
      return [...this.graph(root), 'checkbox-toggle'] as const
    },
    contextInsert(root: GraphRoot) {
      return [...this.graph(root), 'context-insert'] as const
    },
    snippetToggle(root: GraphRoot) {
      return [...this.graph(root), 'snippet-toggle'] as const
    },
  },
  pinnedNotes: {
    all: ['pinned-notes'] as const,
    reorder(root: GraphRoot) {
      return [...this.all, root, 'reorder'] as const
    },
  },
  agentSkill: {
    all: ['agent-skill'] as const,
    write(root: GraphRoot) {
      return [...this.all, root, 'write'] as const
    },
  },
  iap: {
    all: ['iap'] as const,
    get purchase() {
      return [...this.all, 'purchase'] as const
    },
    get restore() {
      return [...this.all, 'restore'] as const
    },
  },
  settings: {
    all: ['settings'] as const,
    get save() {
      return [...this.all, 'save'] as const
    },
  },
} as const

export const mutationScopeIds = {
  pinnedNotesReorder: (root: string) => `pinned-notes:reorder:${root}`,
  agentSkillWrite: (root: GraphRoot) => `agent-skill:write:${root ?? 'none'}`,
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
queryClient.setQueryDefaults(queryKeys.settings.all, { staleTime: Infinity })

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
