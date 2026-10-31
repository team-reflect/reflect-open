import { describe, expect, it } from 'vitest'
import { createTestAttachmentService } from './attachments.ts'

describe('createTestAttachmentService', () => {
  it('rejects a catalog load while no graph session is open', async () => {
    const attachments = createTestAttachmentService({
      graphSession: { getState: () => ({ session: null }) },
    })

    await expect(attachments.loadCatalog()).rejects.toThrow('No graph is open.')
  })

  it('loads the catalog while a graph session is open', async () => {
    const attachments = createTestAttachmentService()

    await expect(attachments.loadCatalog()).resolves.toBe(attachments.peekCatalog())
  })
})
