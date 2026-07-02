import {
  indexedNoteSchema,
  ReflectError,
  type AppPlatform,
  type IpcBridge,
} from '@reflect/core'
import { z } from 'zod'
import type { DevFileStore } from '@/dev/dev-file-store'
import type { DevIndexDb } from '@/dev/dev-index-db'

/** The fixed fake graph root the dev bridge reports (mirrors `mobile_graph_root`). */
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
const applyArgsSchema = z.object({ note: indexedNoteSchema })
const applyBatchArgsSchema = z.object({ notes: z.array(indexedNoteSchema) })
const settingsArgsSchema = z.object({ settings: z.record(z.string(), z.unknown()) })

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

  async function invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'app_version':
        return '0.0.0-dev'
      case 'app_platform':
        return platform
      case 'mobile_graph_root':
        return DEV_GRAPH_ROOT
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
        files.write(path, contents)
        return null
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
        return null
      case 'secret_set':
      case 'secret_delete':
        return null

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

      case 'chat_conversation_delete':
        return null

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
