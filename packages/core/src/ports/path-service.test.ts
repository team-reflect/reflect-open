import { describe, expect, it } from 'vitest'
import { createPathService, createPosixPathTransport } from './path-service.ts'

describe('createPathService', () => {
  it('derives the iCloud Drive root from the home directory', async () => {
    const path = createPathService({ transport: createPosixPathTransport('/Users/alex') })
    await expect(path.homeDir()).resolves.toBe('/Users/alex')
    await expect(path.icloudDriveRoot()).resolves.toBe(
      '/Users/alex/Library/Mobile Documents/com~apple~CloudDocs',
    )
  })
})

describe('createPosixPathTransport', () => {
  it('joins with POSIX syntax', () => {
    const transport = createPosixPathTransport('/')
    const join = (...parts: string[]) => transport.join(...parts)
    expect(join('/g', 'notes/a.md')).toBe('/g/notes/a.md')
    expect(join('/g/', '/notes/', './a.md')).toBe('/g/notes/a.md')
    expect(join('/g', '../h', 'a.md')).toBe('/h/a.md')
    expect(join('/', '..')).toBe('/')
    expect(join('a', '..', '..', 'b')).toBe('../b')
    expect(join('')).toBe('.')
  })
})
