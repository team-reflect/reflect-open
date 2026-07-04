import { z } from 'zod'

/** Identity of an open graph (mirrors the Rust `GraphInfo`). */
export const graphInfoSchema = z.object({
  /** Absolute path of the graph root. */
  root: z.string(),
  /** Display name (the root folder name). */
  name: z.string(),
  /**
   * Open-session generation, bumped by Rust on every graph open. Mutating file
   * commands echo it back and are rejected when stale, so a write enqueued for
   * one graph can never land in another graph's same-named file.
   */
  generation: z.number(),
})
export type GraphInfo = z.infer<typeof graphInfoSchema>

/** A previously-opened graph (mirrors the Rust `RecentGraph`). */
export const recentGraphSchema = z.object({
  root: z.string(),
  name: z.string(),
  /** When it was last opened, epoch milliseconds. */
  openedMs: z.number(),
})
export type RecentGraph = z.infer<typeof recentGraphSchema>

/** Metadata for a file inside the graph (mirrors the Rust `FileMeta`). */
export const fileMetaSchema = z.object({
  /** Graph-relative path, forward-slashed. */
  path: z.string(),
  size: z.number(),
  /** Last-modified time in epoch milliseconds. */
  modifiedMs: z.number(),
  /**
   * True when the file is an iCloud eviction placeholder (Plan 21): the file
   * exists but its content is offloaded until re-download. It must not be
   * read — and must not be treated as deleted. Rust omits the field for
   * regular files.
   */
  placeholder: z.boolean().optional(),
})
export type FileMeta = z.infer<typeof fileMetaSchema>

/** Result of importing a Reflect V1 graph-shaped zip into the open graph. */
export const graphImportSummarySchema = z.object({
  /** Files newly written to the open graph. */
  importedFiles: z.number(),
  /** Files already present with identical bytes, left untouched. */
  skippedFiles: z.number(),
  /** Graph-relative paths newly written to the open graph. */
  changedPaths: z.array(z.string()),
})
export type GraphImportSummary = z.infer<typeof graphImportSummarySchema>
