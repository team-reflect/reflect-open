import { formatElapsed } from '@reflect/utils'
import type { GraphServices } from '../create-graph-services.ts'
import type {
  EmbeddingRuntimeService,
  EmbedStatus,
} from '../embeddings/embedding-runtime-service.ts'
import { errorMessage } from '../errors.ts'
import type { GraphSessionService } from '../graph/graph-session-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { FileMeta } from '../graph/schemas.ts'
import { formatBytes } from '../lib/format-bytes.ts'
import type { AppInfoService } from '../ports/app-info-service.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import type { GitSyncState } from '../sync/git-sync-service.ts'

export interface DiagnosticsServiceDeps {
  readonly appInfo: AppInfoService
  readonly embeddingRuntime: EmbeddingRuntimeService
  readonly graphSession: Pick<GraphSessionService<GraphServices>, 'getState'>
  readonly noteFile: NoteFileService
  readonly settings: SettingsService
}

/**
 * The support report for a bug about memory or speed.
 */
export interface DiagnosticsService {
  /**
   * Memory use, uptime, enabled integrations, and graph size as plain text
   * lines. Holds no note content or paths. A fact that fails to load reads
   * `unavailable` with the error.
   */
  collect(): Promise<string>
}

class DiagnosticsServiceImpl implements DiagnosticsService {
  readonly #deps: DiagnosticsServiceDeps

  constructor(deps: DiagnosticsServiceDeps) {
    this.#deps = deps
  }

  async collect(): Promise<string> {
    const { appInfo, embeddingRuntime, graphSession, noteFile, settings } = this.#deps
    const { graph, services } = graphSession.getState()
    const [version, nativeProcess, embed, notes, attachments] = await Promise.allSettled([
      appInfo.version(),
      appInfo.processDiagnostics(),
      embeddingRuntime.status(),
      graph === null ? null : noteFile.listNotes(graph.generation),
      graph === null ? null : noteFile.listAttachments(graph.generation),
    ])
    const { semanticSearchEnabled, calendarEnabled, contactsEnabled } = settings.get()
    const gitSync = services?.gitSync?.getState() ?? null
    return [
      `Version: ${read(version, (value) => value)}`,
      `OS: ${read(nativeProcess, ({ os, osVersion, arch }) => [os, osVersion, arch].filter(Boolean).join(' '))}`,
      `Main process memory: ${read(nativeProcess, ({ footprintBytes }) => (footprintBytes === null ? 'unknown' : formatBytes(footprintBytes)))}`,
      `Uptime: ${read(nativeProcess, ({ uptimeMs }) => formatElapsed(uptimeMs))}`,
      `Semantic search: ${semanticSearchEnabled ? 'on' : 'off'}, ${read(embed, describeEmbedStatus)}`,
      `Calendar: ${calendarEnabled ? 'on' : 'off'}`,
      `Contacts: ${contactsEnabled ? 'on' : 'off'}`,
      `Git backup: ${describeGitSync(gitSync)}`,
      `Notes: ${read(notes, describeFiles)}`,
      `Attachments: ${read(attachments, describeFiles)}`,
    ].join('\n')
  }
}

export function createDiagnosticsService(deps: DiagnosticsServiceDeps): DiagnosticsService {
  return new DiagnosticsServiceImpl(deps)
}

function read<T>(result: PromiseSettledResult<T>, describe: (value: T) => string): string {
  return result.status === 'fulfilled'
    ? describe(result.value)
    : `unavailable (${errorMessage(result.reason)})`
}

function describeEmbedStatus(embed: EmbedStatus): string {
  switch (embed.status) {
    case 'ready':
      return `model ${embed.model} loaded`
    case 'failed':
      return `model failed: ${embed.message}`
    default:
      return `model ${embed.status}`
  }
}

function describeGitSync(gitSync: GitSyncState | null): string {
  if (gitSync === null) {
    return 'off'
  }
  return gitSync.phase === 'connected' ? `connected, ${gitSync.status.state}` : gitSync.phase
}

function describeFiles(files: FileMeta[] | null): string {
  if (files === null) {
    return 'no graph open'
  }
  if (files.length === 0) {
    return '0'
  }
  let largest = 0
  let total = 0
  for (const file of files) {
    largest = Math.max(largest, file.size)
    total += file.size
  }
  return `${files.length}, ${formatBytes(total)} in total, largest ${formatBytes(largest)}`
}
