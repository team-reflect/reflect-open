export interface AmbiguousNoteChoice {
  readonly id: number
  readonly title: string
  readonly paths: readonly string[]
}

type Listener = () => void

let nextId = 1
let snapshot: AmbiguousNoteChoice | null = null
let resolvePending: ((path: string | null) => void) | null = null
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeAmbiguousNoteChoice(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function ambiguousNoteChoiceSnapshot(): AmbiguousNoteChoice | null {
  return snapshot
}

/** Open the singleton duplicate-note chooser and resolve with its selected path. */
export function chooseAmbiguousNote(
  title: string,
  paths: readonly string[],
): Promise<string | null> {
  resolvePending?.(null)
  snapshot = { id: nextId, title, paths: [...paths].sort() }
  nextId += 1
  emit()
  return new Promise((resolve) => {
    resolvePending = resolve
  })
}

export function settleAmbiguousNoteChoice(path: string | null): void {
  const resolve = resolvePending
  resolvePending = null
  snapshot = null
  emit()
  resolve?.(path)
}
