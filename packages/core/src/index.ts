/**
 * `@reflect/core` — the TypeScript business-logic layer.
 *
 * Per the architecture conventions, all reads, orchestration, AI/provider
 * calls, and privacy guards live here; the Rust shell provides only native
 * primitives reached through the injected bridge.
 *
 * API stability: the typed command bindings, schemas, and error contract are
 * the surface apps build on. The smaller export barrels below preserve this
 * public surface while keeping each file reviewable.
 */
export * from './exports/platform.ts'
export * from './exports/ai-actions.ts'
export * from './exports/link-preview.ts'
export * from './exports/sync-markdown-indexing.ts'
export {
  TaskStore,
  indexedTaskKey,
  type Task,
  type TaskPatch,
  type TaskStoreIO,
  type TaskTarget,
} from './tasks/task-store.ts'
