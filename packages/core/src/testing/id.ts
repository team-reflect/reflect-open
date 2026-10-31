import type { IdService } from '../ports/id-service.ts'

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'

function crockford(value: number, length: number): string {
  let out = ''
  let rest = value
  for (let i = 0; i < length; i++) {
    out = CROCKFORD.charAt(rest % 32) + out
    rest = Math.floor(rest / 32)
  }
  return out
}

/**
 * FNV-1a, so each seed gets its own id space.
 */
function seedNumber(seed: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 0x01000193) >>> 0
  }
  return seed === '' ? 0 : hash
}

export interface TestIdService extends IdService {
  /**
   * Every `uuid()` and `noteId()` value, in issue order.
   */
  issued(): readonly string[]
}

class TestIdServiceImpl implements TestIdService {
  readonly #uuidPrefix: string
  readonly #ulidTime: string
  readonly #issued: string[] = []
  #uuidCount = 0
  #noteIdCount = 0

  constructor(seed: number) {
    this.#uuidPrefix = seed.toString(16).padStart(8, '0')
    this.#ulidTime = crockford(seed, 10)
  }

  uuid(): string {
    this.#uuidCount += 1
    const value = `${this.#uuidPrefix}-0000-4000-8000-${this.#uuidCount.toString(16).padStart(12, '0')}`
    this.#issued.push(value)
    return value
  }

  noteId(): string {
    this.#noteIdCount += 1
    const value = this.#ulidTime + crockford(this.#noteIdCount, 16)
    this.#issued.push(value)
    return value
  }

  issued(): readonly string[] {
    return [...this.#issued]
  }
}

/**
 * Deterministic ids: `uuid()` counts up from `00000000-0000-4000-8000-000000000001`
 * and `noteId()` returns monotonic lowercase ULIDs. A `seed` changes the first
 * UUID group and the ULID timestamp.
 */
export function createTestIdService(options?: { seed?: string }): TestIdService {
  return new TestIdServiceImpl(seedNumber(options?.seed ?? ''))
}
