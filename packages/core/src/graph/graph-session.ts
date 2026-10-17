import { AppError } from '../errors.ts'

/**
 * The main window owns the graph; a note window adopts the main window's sessions.
 */
export type GraphRole = 'main' | 'note-window'

/**
 * One open graph: its identity, both session generations, and its lifetime.
 */
export interface GraphSession {
  /**
   * Absolute path of the graph root.
   */
  readonly root: string
  /**
   * Display name (the root folder name).
   */
  readonly name: string
  /**
   * The file session generation from `graph_open`.
   */
  readonly generation: number
  /**
   * The index session generation from `index_open`; null when the index failed to open.
   */
  readonly indexGeneration: number | null
  /**
   * The role of this window for the session.
   */
  readonly role: GraphRole
  /**
   * Aborts when the graph closes or another graph replaces it.
   */
  readonly signal: AbortSignal
}

/**
 * A {@link GraphSession} over `fields`. Without `role`, the session is the
 * main window's. Without `signal`, the session never aborts.
 */
export function createGraphSession(
  fields: Omit<GraphSession, 'signal' | 'role'> & { readonly role?: GraphRole },
  signal?: AbortSignal,
): GraphSession {
  return {
    root: fields.root,
    name: fields.name,
    generation: fields.generation,
    indexGeneration: fields.indexGeneration,
    role: fields.role ?? 'main',
    signal: signal ?? new AbortController().signal,
  }
}

/**
 * Where a service reads the open graph's {@link GraphSession} from (`GraphSessionService`).
 */
export interface GraphSessionSource {
  getState: () => { readonly session: GraphSession | null }
}

/**
 * The open graph's session; throws `No graph is open.` when none is open.
 */
export function requireGraphSession(graphSession: GraphSessionSource): GraphSession {
  const { session } = graphSession.getState()
  if (session === null) {
    throw new AppError('noGraph', 'No graph is open.')
  }
  return session
}

/**
 * The generation a long-lived writer opened on `captured` writes with now: the
 * open session's when it is the same graph reopened, else `captured`'s own,
 * which Rust rejects once another graph replaced it.
 */
export function writeGenerationFor(
  graphSession: GraphSessionSource,
  captured: GraphSession,
): number {
  const { session } = graphSession.getState()
  return session !== null && session.root === captured.root
    ? session.generation
    : captured.generation
}
