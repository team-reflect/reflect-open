import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'

import { createAgentSkillService } from './agent-skill-service.ts'
import { createGraphSession, type GraphSession } from '../graph/graph-session.ts'

function graphAt(generation: number): { getState: () => { session: GraphSession | null } } {
  const session = createGraphSession({ root: '/g', name: 'g', generation, indexGeneration: 1 })
  return { getState: () => ({ session }) }
}

const STATUS = {
  skillName: 'reflect-notes',
  skillPath: '/home/.agents/skills/reflect-notes/SKILL.md',
  cliPath: '/app/reflect',
  installState: 'missing',
}
describe('createAgentSkillService', () => {
  it('reads the status and pins mutations to the open graph generation', async () => {
    const ipc = createTestIpcBridgeService({
      commands: {
        skill_status: () => STATUS,
        skill_install: () => ({ ...STATUS, installState: 'current' }),
        skill_uninstall: () => STATUS,
      },
    })
    const skill = createAgentSkillService({ ipc, graphSession: graphAt(3) })

    await expect(skill.status()).resolves.toEqual(STATUS)
    await expect(skill.install()).resolves.toMatchObject({ installState: 'current' })
    await expect(skill.uninstall()).resolves.toMatchObject({ installState: 'missing' })
    expect(ipc.calls()).toEqual([
      { command: 'skill_status', args: {} },
      { command: 'skill_install', args: { generation: 3 } },
      { command: 'skill_uninstall', args: { generation: 3 } },
    ])
  })

  it('rejects a mutation when no graph is open', async () => {
    const ipc = createTestIpcBridgeService({ commands: {} })
    const skill = createAgentSkillService({
      ipc,
      graphSession: { getState: () => ({ session: null }) },
    })

    await expect(skill.install()).rejects.toThrow('No graph is open.')
    expect(ipc.calls()).toEqual([])
  })

  it('rejects an unknown install state with a parse error', async () => {
    const ipc = createTestIpcBridgeService({
      commands: { skill_status: () => ({ ...STATUS, installState: 'weird' }) },
    })
    await expect(
      createAgentSkillService({ ipc, graphSession: graphAt(1) }).status(),
    ).rejects.toMatchObject({
      kind: 'parse',
    })
  })
})
