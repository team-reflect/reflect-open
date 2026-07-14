import { describe, expect, it, vi } from 'vitest'
import { createDevAttachmentStore } from '@/dev/dev-attachment-store'

const PNG_BASE64 = 'iVBORw=='

describe('dev attachment store display URLs', () => {
  it('pins URLs to the graph generation and revokes them on replacement and reset', () => {
    let nextUrl = 1
    const objectUrls = {
      createObjectURL: vi.fn((_blob: Blob) => `blob:https://reflect.test/${nextUrl++}`),
      revokeObjectURL: vi.fn((_url: string) => {}),
    }
    const store = createDevAttachmentStore(
      1,
      { 'Media/photo.png': PNG_BASE64 },
      objectUrls,
    )

    expect(store.displayUrl(0, 'Media/photo.png')).toBeNull()
    expect(store.displayUrl(1, '../Media/photo.png')).toBeNull()
    expect(store.displayUrl(1, 'Media/missing.png')).toBeNull()
    expect(store.displayUrl(1, 'Media/photo.png')).toBe('blob:https://reflect.test/1')
    expect(store.displayUrl(1, 'Media/photo.png')).toBe('blob:https://reflect.test/1')
    expect(objectUrls.createObjectURL).toHaveBeenCalledTimes(1)
    expect(objectUrls.createObjectURL.mock.calls[0]?.[0].type).toBe('image/png')

    store.writeBytes('Media/photo.png', new Uint8Array([1, 2, 3]))
    expect(objectUrls.revokeObjectURL).toHaveBeenCalledWith('blob:https://reflect.test/1')
    expect(store.displayUrl(1, 'Media/photo.png')).toBe('blob:https://reflect.test/2')

    store.reset(2, { 'Media/next.webp': 'AQID' })
    expect(objectUrls.revokeObjectURL).toHaveBeenCalledWith('blob:https://reflect.test/2')
    expect(store.displayUrl(1, 'Media/next.webp')).toBeNull()
    expect(store.displayUrl(2, 'Media/next.webp')).toBe('blob:https://reflect.test/3')

    store.dispose()
    expect(objectUrls.revokeObjectURL).toHaveBeenCalledWith('blob:https://reflect.test/3')
    expect(store.list()).toEqual([])
  })

  it('rejects hidden, unsupported, and traversal paths before storing bytes', () => {
    const store = createDevAttachmentStore(1)

    expect(() => store.writeBytes('.private/photo.png', new Uint8Array())).toThrow()
    expect(() => store.writeBytes('../photo.png', new Uint8Array())).toThrow()
    expect(() => store.writeBytes('Media/archive.zip', new Uint8Array())).toThrow()
  })
})
