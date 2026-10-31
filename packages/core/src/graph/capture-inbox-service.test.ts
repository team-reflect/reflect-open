import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService } from '../testing/index.ts'
import { createCaptureInboxService } from './capture-inbox-service.ts'
describe('createCaptureInboxService', () => {
  it('sends each operation as its command with the graph generation', async () => {
    const ipc = createTestIpcBridgeService()
    for (const command of [
      'capture_host_register',
      'capture_inbox_spool',
      'capture_inbox_remove',
      'capture_inbox_reject',
      'capture_screenshot_promote',
    ]) {
      ipc.onCommand(command, () => null)
    }
    const inbox = createCaptureInboxService({ ipc })

    await inbox.registerHost()
    await inbox.spool('a.json', '{}', 3)
    await inbox.remove('a.json', 3)
    await inbox.reject('b.json', 3)
    await inbox.promoteScreenshot('a.jpg', 'assets/a.jpg', 1600, 3)

    expect(ipc.calls()).toEqual([
      { command: 'capture_host_register', args: {} },
      { command: 'capture_inbox_spool', args: { name: 'a.json', json: '{}', generation: 3 } },
      { command: 'capture_inbox_remove', args: { name: 'a.json', generation: 3 } },
      { command: 'capture_inbox_reject', args: { name: 'b.json', generation: 3 } },
      {
        command: 'capture_screenshot_promote',
        args: { spoolName: 'a.jpg', assetPath: 'assets/a.jpg', maxDim: 1600, generation: 3 },
      },
    ])
  })

  it('validates list, read, and relay answers', async () => {
    const entry = { path: '.reflect/inbox/a.json', size: 2, modifiedMs: 5 }
    const ipc = createTestIpcBridgeService({
      commands: {
        capture_inbox_list: () => [entry],
        capture_inbox_read: () => '{}',
        capture_shared_inbox_relay: () => 2,
      },
    })
    const inbox = createCaptureInboxService({ ipc })

    await expect(inbox.list(3)).resolves.toEqual([entry])
    await expect(inbox.read('a.json', 3)).resolves.toBe('{}')
    await expect(inbox.relaySharedInbox(3)).resolves.toBe(2)

    ipc.onCommand('capture_shared_inbox_relay', () => 'two')
    await expect(inbox.relaySharedInbox(3)).rejects.toMatchObject({ kind: 'parse' })
  })
})
