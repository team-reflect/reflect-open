import { ulid } from 'ulid'

/**
 * Fresh random identifiers.
 */
export interface IdService {
  /**
   * A random RFC 4122 version 4 UUID.
   */
  uuid(): string
  /**
   * A fresh note `id`: a lowercase Crockford base32 ULID.
   */
  noteId(): string
}

class SystemIdServiceImpl implements IdService {
  uuid(): string {
    return crypto.randomUUID()
  }

  noteId(): string {
    return ulid().toLowerCase()
  }
}

export function createSystemIdService(): IdService {
  return new SystemIdServiceImpl()
}
