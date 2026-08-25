import {
  hashContent,
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
const createArgsSchema = writeArgsSchema.extend({
  generation: z.number().int().nonnegative(),
  requesterOwnerId: z.string().optional(),
})
const revisionWriteArgsSchema = createArgsSchema.extend({
  expectedRevision: z.string(),
  requesterOwnerId: z.string().optional(),
})
const revisionTrashArgsSchema = z.object({
  path: z.string(),
  expectedRevision: z.string(),
  generation: z.number().int().nonnegative(),
  requesterOwnerId: z.string().optional(),
})
const noteWindowClaimArgsSchema = z.object({
  path: z.string(),
  ownerId: z.string(),
  generation: z.number().int().nonnegative(),
})
const noteWindowReleaseArgsSchema = z.object({ path: z.string(), ownerId: z.string() })
const moveArgsSchema = z.object({ from: z.string(), to: z.string() })
const moveRequestArgsSchema = z.object({
  request: z.object({ from: z.string(), to: z.string() }),
})
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
    permissionMode: z.enum(['read', 'readWrite']).default('read'),
    sourceProvenance: z.string().nullable().default(null),
    createdMs: z.number(),
  }),
})
const chatDeleteArgsSchema = z.object({ id: z.string() })
const changeOperationSchema = z.enum(['edit', 'append', 'create'])
const changeStateSchema = z.enum([
  'prepared',
  'applied',
  'undoing',
  'undone',
  'failed',
  'uncertain',
])
const chatNoteChangeInputSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  turnId: z.string(),
  toolCallId: z.string(),
  path: z.string(),
  sequence: z.number().int().nonnegative(),
  operation: changeOperationSchema,
  beforeSource: z.string().nullable(),
  afterSource: z.string(),
  beforeRevision: z.string().nullable(),
  afterRevision: z.string(),
  createdMs: z.number(),
})
const chatNoteChangePrepareArgsSchema = z.object({
  change: chatNoteChangeInputSchema,
  generation: z.number().int().nonnegative(),
})
const chatNoteChangeStateArgsSchema = z.object({
  id: z.string(),
  expectedState: changeStateSchema,
  state: changeStateSchema,
  errorMessage: z.string().nullable(),
  updatedMs: z.number(),
  generation: z.number().int().nonnegative(),
})
const chatNoteChangesStateBatchArgsSchema = z.object({
  ids: z.array(z.string()),
  expectedState: changeStateSchema,
  state: changeStateSchema,
  errorMessage: z.string().nullable(),
  updatedMs: z.number(),
  generation: z.number().int().nonnegative(),
})
const chatTurnChangesArgsSchema = z.object({
  turnId: z.string(),
  generation: z.number().int().nonnegative(),
})
const chatPendingChangesArgsSchema = z.object({ generation: z.number().int().nonnegative() })

/**
 * The in-browser stand-in for the Rust shell (dev builds only): answers the
 * command surface the desktop and mobile trees exercise from an in-memory
 * file map and the wasm SQLite index. The in-memory graph has one fixed
 * generation (`1`); the
 * no-clobber note-create command validates that value before touching the
 * store, matching its native race-safety contract.
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
  const noteOwners = new Map<string, Set<string>>()

  function ownershipPathKey(path: string): string {
    return path.normalize('NFC').toLowerCase().normalize('NFC')
  }

  function noteOwnedByAnother(path: string, requesterOwnerId?: string): boolean {
    const owners = noteOwners.get(ownershipPathKey(path))
    return owners !== undefined && [...owners].some((ownerId) => ownerId !== requesterOwnerId)
  }

  async function invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'app_version':
        return '0.0.0-dev'
      case 'app_platform':
        return platform
      case 'background_task_begin':
        // Browser previews are never suspended like an iOS process, so the
        // native finite-length assertion is honestly unavailable.
        return null
      case 'plugin:mobile-haptics|impact_light':
        return null
      case 'mobile_storage':
        // No iCloud in a plain browser — the dev harness exercises the
        // local-storage path (and, via `mobileOnboarded` above, skips
        // onboarding entirely).
        return { localRoot: DEV_GRAPH_ROOT, icloudDocumentsRoot: null, icloudGraphRoots: [] }
      case 'mobile_storage_local':
        return DEV_GRAPH_ROOT
      case 'icloud_download_pending':
      case 'icloud_request_downloads':
        return 0
      case 'graph_open':
      case 'graph_create':
        return graphInfo
      case 'recent_graphs':
        // One seeded recent so the desktop chooser has something to open —
        // the browser has no folder picker, so this is the only entry point.
        return [{ root: graphInfo.root, name: graphInfo.name, openedMs: Date.now() }]
      case 'icloud_status':
        // No iCloud container in a browser; the chooser's iCloud card hides.
        return { available: false, documentsRoot: null, existingGraphRoots: [] }
      case 'embed_status':
        // `failed` is the designed recoverable "unavailable" state — semantic
        // search surfaces show it honestly instead of offering a download.
        return { status: 'failed', message: 'embeddings are unavailable in browser dev' }
      case 'vault_scan_stats':
        return { notes: files.list().length, attachments: 0, skipped: 0 }
      case 'list_attachments':
        return []
      case 'forget_recent':
      case 'capture_host_register':
      case 'watch_start':
      case 'watch_stop':
      case 'background_task_end':
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
      case 'note_read_for_ai': {
        const { path, generation, requesterOwnerId } = z
          .object({
            path: z.string(),
            generation: z.number().int().nonnegative(),
            requesterOwnerId: z.string().optional(),
          })
          .parse(args)
        if (generation !== graphInfo.generation) {
          throw new ReflectError(
            'io',
            'the graph changed since this command was issued; dropping it',
          )
        }
        if (noteOwnedByAnother(path, requesterOwnerId)) {
          return { kind: 'blocked' }
        }
        const source = files.read(path)
        if (source === null) {
          return { kind: 'missing' }
        }
        return { kind: 'content', source, revision: await hashContent(source) }
      }
      case 'note_window_claim': {
        const { path, ownerId, generation } = noteWindowClaimArgsSchema.parse(args)
        if (generation !== graphInfo.generation) {
          throw new ReflectError(
            'io',
            'the graph changed since this command was issued; dropping it',
          )
        }
        const key = ownershipPathKey(path)
        const owners = noteOwners.get(key) ?? new Set<string>()
        owners.add(ownerId)
        noteOwners.set(key, owners)
        return null
      }
      case 'note_window_release': {
        const { path, ownerId } = noteWindowReleaseArgsSchema.parse(args)
        const key = ownershipPathKey(path)
        const owners = noteOwners.get(key)
        owners?.delete(ownerId)
        if (owners?.size === 0) {
          noteOwners.delete(key)
        }
        return null
      }
      case 'note_read_local': {
        // The in-memory store has no iCloud, so a note is never evicted.
        const { path } = pathArgsSchema.parse(args)
        const contents = files.read(path)
        if (contents === null) {
          throw new ReflectError('notFound', `no such note: ${path}`)
        }
        return { kind: 'content', content: contents }
      }
      case 'note_write': {
        const { path, contents } = writeArgsSchema.parse(args)
        return files.write(path, contents)
      }
      case 'note_write_if_revision': {
        const { path, contents, expectedRevision, generation, requesterOwnerId } =
          revisionWriteArgsSchema.parse(args)
        if (generation !== graphInfo.generation) {
          throw new ReflectError(
            'io',
            'the graph changed since this command was issued; dropping it',
          )
        }
        if (noteOwnedByAnother(path, requesterOwnerId)) {
          return { kind: 'blocked' }
        }
        const current = files.read(path)
        if (current === null) {
          return { kind: 'missing' }
        }
        const currentRevision = await hashContent(current)
        if (currentRevision !== expectedRevision) {
          return { kind: 'stale', currentRevision }
        }
        const modifiedMs = files.write(path, contents)
        return { kind: 'written', revision: await hashContent(contents), modifiedMs }
      }
      case 'note_create': {
        const { path, contents, generation, requesterOwnerId } = createArgsSchema.parse(args)
        if (generation !== graphInfo.generation) {
          throw new ReflectError(
            'io',
            'the graph changed since this command was issued; dropping it',
          )
        }
        if (noteOwnedByAnother(path, requesterOwnerId)) {
          return { kind: 'blocked' }
        }
        return files.create(path, contents)
      }
      case 'note_exists':
        return files.exists(pathArgsSchema.parse(args).path)
      case 'note_delete': {
        files.remove(pathArgsSchema.parse(args).path)
        return null
      }
      case 'note_trash_if_revision': {
        const { path, expectedRevision, generation, requesterOwnerId } =
          revisionTrashArgsSchema.parse(args)
        if (generation !== graphInfo.generation) {
          throw new ReflectError(
            'io',
            'the graph changed since this command was issued; dropping it',
          )
        }
        if (noteOwnedByAnother(path, requesterOwnerId)) {
          return { kind: 'blocked' }
        }
        const current = files.read(path)
        if (current === null) {
          return { kind: 'missing' }
        }
        const currentRevision = await hashContent(current)
        if (currentRevision !== expectedRevision) {
          return { kind: 'stale', currentRevision }
        }
        files.remove(path)
        return { kind: 'trashed' }
      }
      case 'list_files':
        return files.list()
      case 'dir_list':
        return files.listDir(z.object({ dir: z.string() }).parse(args).dir)
      case 'note_move_indexed': {
        const {
          request: { from, to },
        } = moveRequestArgsSchema.parse(args)
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
      case 'asset_reveal':
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
      case 'chat_note_change_prepare': {
        const { change, generation } = chatNoteChangePrepareArgsSchema.parse(args)
        requireDevGeneration(generation, graphInfo.generation)
        return index.prepareChatNoteChange(change)
      }
      case 'chat_note_change_set_state': {
        const { generation, ...input } = chatNoteChangeStateArgsSchema.parse(args)
        requireDevGeneration(generation, graphInfo.generation)
        return index.setChatNoteChangeState(input)
      }
      case 'chat_note_changes_set_state_batch': {
        const { generation, ...input } = chatNoteChangesStateBatchArgsSchema.parse(args)
        requireDevGeneration(generation, graphInfo.generation)
        return index.setChatNoteChangesStateBatch(input)
      }
      case 'chat_note_changes_for_turn': {
        const { turnId, generation } = chatTurnChangesArgsSchema.parse(args)
        requireDevGeneration(generation, graphInfo.generation)
        return index.chatNoteChangesForTurn(turnId)
      }
      case 'chat_note_changes_pending': {
        const { generation } = chatPendingChangesArgsSchema.parse(args)
        requireDevGeneration(generation, graphInfo.generation)
        return index.pendingChatNoteChanges()
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
    // refresh the UI through core's in-process local-write echo. Plugin event
    // registrations get the same treatment, so the keyboard and recorder
    // hooks mount cleanly in the harness.
    listen: async () => () => {},
    listenPlugin: async () => {},
  }
}

function requireDevGeneration(generation: number, expected: number): void {
  if (generation !== expected) {
    throw new ReflectError('io', 'the graph changed since this command was issued; dropping it')
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
      .map((row) => [
        String(row['path']),
        { mtime: Number(row['mtime']), hash: String(row['file_hash']) },
      ]),
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
  const orphans = [...stored]
    .filter(([path]) => !onDisk.has(path))
    .map(([path, facts]) => ({ path, storedMtime: facts.mtime, storedHash: facts.hash }))
    .sort((first, second) => first.path.localeCompare(second.path))
  return { total: listing.length, candidates, orphans, stalePlaceholders: [] }
}
