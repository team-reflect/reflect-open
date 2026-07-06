import {
  indexedNoteSchema,
  ReflectError,
  type AppPlatform,
  type IpcBridge,
} from '@reflect/core'
import { z } from 'zod'
import type { DevFileStore } from '@/dev/dev-file-store'
import type { DevIndexDb } from '@/dev/dev-index-db'

/** The fixed fake graph root the dev bridge reports (mirrors `mobile_storage`). */
export const DEV_GRAPH_ROOT = '/dev-graph'

/** Everything the command router needs; assembled by `installDevBridge`. */
export interface DevBridgeBackend {
  /** The platform `app_platform` reports (the `?platform=` override value). */
  platform: AppPlatform
  files: DevFileStore
  index: DevIndexDb
}

const dbQueryArgsSchema = z.object({ sql: z.string(), params: z.array(z.unknown()) })
const pathArgsSchema = z.object({ path: z.string() })
const writeArgsSchema = z.object({ path: z.string(), contents: z.string() })
const moveArgsSchema = z.object({ from: z.string(), to: z.string() })
const metaArgsSchema = z.object({ key: z.string(), value: z.string() })
const touchArgsSchema = z.object({
  entries: z.array(z.object({ path: z.string(), mtime: z.number() })),
})
const applyArgsSchema = z.object({ note: indexedNoteSchema })
const applyBatchArgsSchema = z.object({ notes: z.array(indexedNoteSchema) })
const settingsArgsSchema = z.object({ settings: z.record(z.string(), z.unknown()) })
const secretNameArgsSchema = z.object({ name: z.string() })
const secretSetArgsSchema = z.object({ name: z.string(), value: z.string() })
const chatSaveArgsSchema = z.object({
  conversation: z.object({
    id: z.string(),
    title: z.string(),
    createdMs: z.number(),
    updatedMs: z.number(),
  }),
  message: z.object({
    id: z.string(),
    conversationId: z.string(),
    userText: z.string(),
    attachments: z.string(),
    parts: z.string(),
    responseMessages: z.string(),
    createdMs: z.number(),
  }),
})
const chatDeleteArgsSchema = z.object({ id: z.string() })

/**
 * The in-browser stand-in for the Rust shell (dev builds only): answers the
 * command surface the mobile tree exercises from an in-memory file map and the
 * wasm SQLite index. Filesystem generations are meaningless with one immortal
 * in-memory graph, so `generation` args are accepted and ignored (always 1).
 *
 * Anything unimplemented rejects loudly with the command name — a surface
 * quietly rendering empty because a stub answered wrong is worse than an
 * error naming the gap.
 */
export function createDevBridge(backend: DevBridgeBackend): IpcBridge {
  const { platform, files, index } = backend
  const graphInfo = { root: DEV_GRAPH_ROOT, name: 'Dev Graph', generation: 1 }
  let settingsDocument: Record<string, unknown> = { mobileOnboarded: true }
  const assets = new Map<string, string>()
  // In-memory keychain stand-in so the AI-provider settings flow (and chat,
  // against a CORS-permissive provider) works end-to-end in the harness.
  const secrets = new Map<string, string>()

  async function invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'app_version':
        return '0.0.0-dev'
      case 'app_platform':
        return platform
      case 'mobile_storage':
        // No iCloud in a plain browser — the dev harness exercises the
        // local-storage path (and, via `mobileOnboarded` above, skips
        // onboarding entirely).
        return { localRoot: DEV_GRAPH_ROOT, icloudDocumentsRoot: null, icloudGraphRoots: [] }
      case 'mobile_storage_local':
        return DEV_GRAPH_ROOT
      case 'icloud_download_pending':
        return 0
      case 'graph_open':
      case 'graph_create':
        return graphInfo
      case 'recent_graphs':
        return []
      case 'forget_recent':
      case 'capture_host_register':
      case 'watch_start':
      case 'watch_stop':
      case 'quit_confirm':
      case 'toggle_devtools':
        return null
      case 'capture_inbox_list':
        return []
      case 'capture_shared_inbox_relay':
        // No share-extension App Group inbox in a browser; nothing to relay.
        return 0

      case 'note_read': {
        const { path } = pathArgsSchema.parse(args)
        const contents = files.read(path)
        if (contents === null) {
          throw new ReflectError('notFound', `no such note: ${path}`)
        }
        return contents
      }
      case 'note_write': {
        const { path, contents } = writeArgsSchema.parse(args)
        return files.write(path, contents)
      }
      case 'note_exists':
        return files.exists(pathArgsSchema.parse(args).path)
      case 'note_delete': {
        files.remove(pathArgsSchema.parse(args).path)
        return null
      }
      case 'list_files':
        return files.list()
      case 'dir_list':
        return files.listDir(z.object({ dir: z.string() }).parse(args).dir)
      case 'note_move_indexed': {
        const { from, to } = moveArgsSchema.parse(args)
        if (!files.exists(from)) {
          throw new ReflectError('notFound', `cannot move note: ${from} does not exist`)
        }
        if (files.exists(to)) {
          throw new ReflectError('io', `cannot move note: ${to} already exists`)
        }
        // Index first: it can refuse (occupied path), and a refused move must
        // leave the file untouched — the in-memory stand-in for Rust's
        // file+rows transaction.
        index.moveNote(from, to)
        files.move(from, to)
        return null
      }

      case 'asset_write': {
        const { path, contentsBase64 } = z
          .object({ path: z.string(), contentsBase64: z.string() })
          .parse(args)
        assets.set(path, contentsBase64)
        return null
      }
      case 'asset_read': {
        const { path } = pathArgsSchema.parse(args)
        const contents = assets.get(path)
        if (contents === undefined) {
          throw new ReflectError('notFound', `asset not found: ${path}`)
        }
        return contents
      }
      case 'asset_open':
        return null

      case 'db_query': {
        const { sql, params } = dbQueryArgsSchema.parse(args)
        return index.query(sql, params)
      }
      case 'index_open':
        return 1
      case 'index_apply': {
        index.applyNote(applyArgsSchema.parse(args).note)
        return null
      }
      case 'index_apply_batch': {
        for (const note of applyBatchArgsSchema.parse(args).notes) {
          index.applyNote(note)
        }
        return null
      }
      case 'index_remove': {
        index.removeNote(pathArgsSchema.parse(args).path)
        return null
      }
      case 'index_move': {
        const { from, to } = moveArgsSchema.parse(args)
        index.moveNote(from, to)
        return null
      }
      case 'index_touch': {
        for (const entry of touchArgsSchema.parse(args).entries) {
          index.touchNote(entry.path, entry.mtime)
        }
        return null
      }
      case 'index_reconcile_scan':
        return reconcileScan(files, index)
      case 'index_clear': {
        index.clear()
        return null
      }
      case 'index_meta_set': {
        const { key, value } = metaArgsSchema.parse(args)
        index.setMeta(key, value)
        return null
      }

      case 'settings_load':
        return settingsDocument
      case 'settings_save': {
        settingsDocument = settingsArgsSchema.parse(args).settings
        return null
      }
      case 'secret_get':
        return secrets.get(secretNameArgsSchema.parse(args).name) ?? null
      case 'secret_set': {
        const { name, value } = secretSetArgsSchema.parse(args)
        secrets.set(name, value)
        return null
      }
      case 'secret_delete': {
        secrets.delete(secretNameArgsSchema.parse(args).name)
        return null
      }

      case 'git_status':
        return {
          initialized: false,
          branch: null,
          remoteUrl: null,
          ahead: 0,
          behind: 0,
          inProgress: false,
        }

      case 'calendar_authorization_status':
      case 'contacts_authorization_status':
        return 'denied'
      case 'calendar_list_calendars':
      case 'calendar_list_events':
      case 'contacts_lookup_by_email':
      case 'contacts_lookup_by_name':
        return []

      case 'chat_message_save': {
        const { conversation, message } = chatSaveArgsSchema.parse(args)
        index.saveChatMessage(conversation, message)
        return null
      }
      case 'chat_conversation_delete': {
        index.deleteChatConversation(chatDeleteArgsSchema.parse(args).id)
        return null
      }

      default:
        console.error(`[dev-bridge] unimplemented command "${command}"`, args)
        throw new ReflectError('unknown', `dev bridge: unimplemented command "${command}"`)
    }
  }

  return {
    invoke,
    // Native event streams (watcher, embeddings, EventKit) don't exist in the
    // browser; subscriptions succeed and simply never fire. Local writes still
    // refresh the UI through core's in-process local-write echo.
    listen: async () => () => {},
  }
}

/** Mirrors `MTIME_TRUST_AGE_MS` in core's hash.ts and Rust's scan.rs. */
const MTIME_TRUST_AGE_MS = 5_000

/**
 * The `index_reconcile_scan` stand-in: the same listing-vs-rows comparison
 * `src-tauri/src/db/scan.rs` runs natively, over the in-memory store. The
 * dev store never lists placeholders, so that arm has no mirror here.
 */
function reconcileScan(files: DevFileStore, index: DevIndexDb) {
  const stored = new Map(
    index
      .query('SELECT path, mtime, file_hash FROM notes', [])
      .map((row) => [String(row['path']), { mtime: Number(row['mtime']), hash: String(row['file_hash']) }]),
  )
  const now = Date.now()
  const listing = files.list()
  const onDisk = new Set(listing.map((file) => file.path))
  const candidates = []
  for (const file of listing) {
    const facts = stored.get(file.path)
    const settled = now - file.modifiedMs >= MTIME_TRUST_AGE_MS
    if (settled && facts !== undefined && facts.mtime === file.modifiedMs) {
      continue
    }
    candidates.push({
      path: file.path,
      modifiedMs: file.modifiedMs,
      storedMtime: facts?.mtime ?? null,
      storedHash: facts?.hash ?? null,
    })
  }
  const orphans = [...stored.entries()]
    .filter(([path]) => !onDisk.has(path))
    .map(([path, facts]) => ({ path, storedMtime: facts.mtime, storedHash: facts.hash }))
    .sort((first, second) => first.path.localeCompare(second.path))
  return { total: listing.length, candidates, orphans }
}
