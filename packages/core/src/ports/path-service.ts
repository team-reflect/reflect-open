import type { MaybePromise } from '@reflect/utils'
/**
 * Host filesystem path building, in the host platform's path syntax.
 */
export interface PathService {
  join(...parts: string[]): Promise<string>
  /**
   * The current user's home directory.
   */
  homeDir(): Promise<string>
  /**
   * The macOS iCloud Drive folder under {@link homeDir}.
   */
  icloudDriveRoot(): Promise<string>
}

/**
 * The native operations behind a {@link PathService}.
 */
export interface PathTransport {
  join(...parts: string[]): MaybePromise<string>
  homeDir(): MaybePromise<string>
}

const ICLOUD_DRIVE_SEGMENTS = ['Library', 'Mobile Documents', 'com~apple~CloudDocs'] as const

export interface PathServiceDeps {
  readonly transport: PathTransport
}

class PathServiceImpl implements PathService {
  readonly #deps: PathServiceDeps

  constructor(deps: PathServiceDeps) {
    this.#deps = deps
  }

  async join(...parts: string[]): Promise<string> {
    return await this.#deps.transport.join(...parts)
  }

  async homeDir(): Promise<string> {
    return await this.#deps.transport.homeDir()
  }

  async icloudDriveRoot(): Promise<string> {
    const { transport } = this.#deps
    return await transport.join(await transport.homeDir(), ...ICLOUD_DRIVE_SEGMENTS)
  }
}

export function createPathService(deps: PathServiceDeps): PathService {
  return new PathServiceImpl(deps)
}

class PosixPathTransportImpl implements PathTransport {
  readonly #home: string

  constructor(home: string) {
    this.#home = home
  }

  async join(...parts: string[]): Promise<string> {
    return joinPosix(parts)
  }

  async homeDir(): Promise<string> {
    return this.#home
  }
}

/**
 * A {@link PathTransport} with POSIX syntax and a fixed home directory.
 */
export function createPosixPathTransport(home: string): PathTransport {
  return new PosixPathTransportImpl(home)
}

function joinPosix(parts: readonly string[]): string {
  const absolute = parts[0]?.startsWith('/') ?? false
  const segments: string[] = []
  for (const part of parts) {
    for (const segment of part.split('/')) {
      if (segment === '' || segment === '.') {
        continue
      }
      if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop()
      } else if (segment !== '..' || !absolute) {
        segments.push(segment)
      }
    }
  }
  const joined = segments.join('/')
  if (absolute) {
    return `/${joined}`
  }
  return joined === '' ? '.' : joined
}
