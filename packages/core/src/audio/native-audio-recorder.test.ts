import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService, type TestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import type { AudioRecorderState, AudioRecorderStopped } from './audio-recorder-service.ts'
import { createNativeAudioRecorder } from './native-audio-recorder.ts'

const SESSION_STARTED_MS = 1_700_000_000_000
const START_OPTIONS = { segmentMs: 20 * 60_000, reminderMs: 30 * 60_000 }

function setup(options?: { pluginEvents?: boolean }) {
  const ipc = createTestIpcBridgeService({ pluginEvents: options?.pluginEvents ?? true })
  ipc.onCommand('plugin:recording|start_recording', () => ({
    sessionStartedMs: SESSION_STARTED_MS,
  }))
  ipc.onCommand('plugin:recording|delete_staged', () => null)
  const logger = createTestLoggerService()
  const recorder = createNativeAudioRecorder({ ipc, logger })
  return { ipc, logger, recorder }
}

function answerStop(
  ipc: TestIpcBridgeService,
  stop: { path: string; part: number; durationMs: number },
): void {
  ipc.onCommand('plugin:recording|stop_recording', () => ({
    ...stop,
    sessionStartedMs: SESSION_STARTED_MS,
  }))
}

function commands(ipc: TestIpcBridgeService): string[] {
  return ipc.calls().map((call) => call.command)
}

describe('createNativeAudioRecorder', () => {
  it('start passes the segment and reminder lengths and moves to recording', async () => {
    const { ipc, recorder } = setup()
    const states: AudioRecorderState[] = []
    recorder.subscribeState((state) => {
      states.push(state)
    })

    await expect(recorder.start(START_OPTIONS)).resolves.toEqual({
      sessionStartedMs: SESSION_STARTED_MS,
    })

    expect(ipc.calls()).toEqual([
      { command: 'plugin:recording|start_recording', args: { request: START_OPTIONS } },
    ])
    expect(states).toEqual(['requesting', 'recording'])
    await expect(recorder.start(START_OPTIONS)).resolves.toBeNull()
  })

  it('a rejected start returns to idle and rethrows', async () => {
    const { ipc, recorder } = setup()
    ipc.onCommand('plugin:recording|start_recording', () => {
      throw new Error('microphone access denied')
    })

    await expect(recorder.start(START_OPTIONS)).rejects.toMatchObject({
      message: 'microphone access denied',
    })
    expect(recorder.state()).toBe('idle')
  })

  it('stop claims the final segment and returns to idle', async () => {
    const { ipc, recorder } = setup()
    const path = '/staging/stop-normal.m4a'
    answerStop(ipc, { path, part: 2, durationMs: 4000 })
    await recorder.start(START_OPTIONS)

    await expect(recorder.stop()).resolves.toEqual({
      audio: { kind: 'staged', path },
      mimeType: 'audio/mp4',
      sessionStartedMs: SESSION_STARTED_MS,
      part: 2,
      end: true,
      durationMs: 4000,
    })
    expect(recorder.isStagedClaimed(path)).toBe(true)
    expect(recorder.state()).toBe('idle')
  })

  it('concurrent stops share one native stop', async () => {
    const { ipc, recorder } = setup()
    answerStop(ipc, { path: '/staging/twin.m4a', part: 1, durationMs: 4000 })
    await recorder.start(START_OPTIONS)

    const [first, second] = await Promise.all([recorder.stop(), recorder.stop()])

    expect(second).toBe(first)
    expect(commands(ipc).filter((command) => command.endsWith('stop_recording'))).toHaveLength(1)
  })

  it('a too-short one-segment stop deletes the staged file and returns null', async () => {
    const { ipc, recorder } = setup()
    const path = '/staging/stop-short.m4a'
    answerStop(ipc, { path, part: 1, durationMs: 300 })
    await recorder.start(START_OPTIONS)

    await expect(recorder.stop()).resolves.toBeNull()
    expect(ipc.calls()).toContainEqual({
      command: 'plugin:recording|delete_staged',
      args: { request: { path } },
    })
    expect(recorder.isStagedClaimed(path)).toBe(false)
  })

  it('a short later segment still ships: it carries the end marker', async () => {
    const { ipc, recorder } = setup()
    answerStop(ipc, { path: '/staging/late.m4a', part: 2, durationMs: 100 })

    await expect(recorder.stop()).resolves.toMatchObject({ part: 2, end: true })
  })

  it('a rotated segment is claimed and delivered', async () => {
    const { ipc, recorder } = setup()
    const path = '/staging/recording.part-001.m4a'
    const segments: unknown[] = []
    recorder.subscribeSegment((segment) => {
      segments.push(segment)
    })
    await Promise.resolve()

    ipc.emitPlugin('recording', 'recordingSegment', {
      path,
      sessionStartedMs: SESSION_STARTED_MS,
      part: 1,
    })

    expect(segments).toEqual([
      {
        audio: { kind: 'staged', path },
        mimeType: 'audio/mp4',
        sessionStartedMs: SESSION_STARTED_MS,
        part: 1,
        end: false,
      },
    ])
    expect(recorder.isStagedClaimed(path)).toBe(true)
    recorder.releaseStaged(path)
    expect(recorder.isStagedClaimed(path)).toBe(false)
  })

  it('level events reach listeners only while recording', async () => {
    const { ipc, recorder } = setup()
    const levels: number[] = []
    recorder.subscribeLevel((event) => {
      levels.push(event.level)
    })
    await Promise.resolve()

    ipc.emitPlugin('recording', 'recordingLevel', { level: 0.2, elapsedMs: 100 })
    await recorder.start(START_OPTIONS)
    ipc.emitPlugin('recording', 'recordingLevel', { level: 0.5, elapsedMs: 1200 })

    expect(levels).toEqual([0.5])
  })

  it('a native stop ends the session once for every listener', async () => {
    const { ipc, recorder } = setup()
    const path = '/staging/native-stop.m4a'
    const first: AudioRecorderStopped[] = []
    const second: AudioRecorderStopped[] = []
    recorder.subscribeStopped((stopped) => {
      first.push(stopped)
    })
    recorder.subscribeStopped((stopped) => {
      second.push(stopped)
    })
    await recorder.start(START_OPTIONS)

    ipc.emitPlugin('recording', 'recordingStopped', {
      path,
      sessionStartedMs: SESSION_STARTED_MS,
      part: 3,
      durationMs: 5000,
      reason: 'interruption',
    })

    expect(recorder.state()).toBe('idle')
    expect(first).toEqual([
      {
        segment: {
          audio: { kind: 'staged', path },
          mimeType: 'audio/mp4',
          sessionStartedMs: SESSION_STARTED_MS,
          part: 3,
          end: true,
          durationMs: 5000,
        },
        reason: 'interruption',
      },
    ])
    expect(second).toEqual(first)
    expect(recorder.isStagedClaimed(path)).toBe(true)
  })

  it('a too-short native stop deletes the file and reports no segment', async () => {
    const { ipc, recorder } = setup()
    const path = '/staging/native-short.m4a'
    const stopped: AudioRecorderStopped[] = []
    recorder.subscribeStopped((event) => {
      stopped.push(event)
    })
    await Promise.resolve()

    ipc.emitPlugin('recording', 'recordingStopped', {
      path,
      sessionStartedMs: SESSION_STARTED_MS,
      part: 1,
      durationMs: 200,
      reason: 'interruption',
    })

    expect(stopped).toEqual([{ segment: null, reason: 'interruption' }])
    expect(ipc.calls()).toContainEqual({
      command: 'plugin:recording|delete_staged',
      args: { request: { path } },
    })
    expect(recorder.isStagedClaimed(path)).toBe(false)
  })

  it('a native stop landing during start does not resurrect the session', async () => {
    const { ipc, recorder } = setup()
    const pendingStart = Promise.withResolvers<{ sessionStartedMs: number }>()
    ipc.onCommand('plugin:recording|start_recording', () => pendingStart.promise)
    recorder.subscribeStopped(() => {})

    const starting = recorder.start(START_OPTIONS)
    expect(recorder.state()).toBe('requesting')
    await Promise.resolve()
    ipc.emitPlugin('recording', 'recordingStopped', {
      path: '/staging/stop-during-start.m4a',
      sessionStartedMs: SESSION_STARTED_MS,
      part: 1,
      durationMs: 200,
      reason: 'interruption',
    })
    pendingStart.resolve({ sessionStartedMs: SESSION_STARTED_MS })
    await starting

    expect(recorder.state()).toBe('idle')
  })

  it('cancel discards the session and returns to idle', async () => {
    const { ipc, recorder } = setup()
    ipc.onCommand('plugin:recording|cancel_recording', () => null)
    await recorder.start(START_OPTIONS)

    await recorder.cancel()

    expect(recorder.state()).toBe('idle')
    expect(commands(ipc)).toContain('plugin:recording|cancel_recording')
  })

  it('status, listStaged, and deleteStaged run the plugin commands', async () => {
    const { ipc, recorder } = setup()
    const staged = {
      path: '/staging/a.part-001.m4a',
      sessionStartedMs: SESSION_STARTED_MS,
      part: 1,
      end: false,
      modifiedMs: 1,
    }
    ipc.onCommand('plugin:recording|recording_status', () => ({
      recording: true,
      elapsedMs: 42,
    }))
    ipc.onCommand('plugin:recording|list_staged', () => ({ files: [staged] }))

    await expect(recorder.status()).resolves.toEqual({ recording: true, elapsedMs: 42 })
    await expect(recorder.listStaged()).resolves.toEqual([staged])
    await recorder.deleteStaged(staged.path)
    expect(ipc.calls().at(-1)).toEqual({
      command: 'plugin:recording|delete_staged',
      args: { request: { path: staged.path } },
    })
  })

  it('actionsReady registers the native action listener before delivering', async () => {
    const { ipc, recorder } = setup()
    ipc.onCommand('plugin:recording|actions_ready', () => {
      ipc.emitPlugin('recording', 'nativeAction', { action: 'recordAudio' })
      return null
    })
    ipc.onCommand('plugin:recording|action_performed', () => null)
    const actions: string[] = []
    recorder.subscribeNativeAction((event) => {
      actions.push(event.action)
    })

    await recorder.actionsReady()
    await recorder.actionPerformed()

    expect(actions).toEqual(['recordAudio'])
    expect(commands(ipc)).toEqual([
      'plugin:recording|actions_ready',
      'plugin:recording|action_performed',
    ])
  })

  it('actionsReady skips the handshake once its signal is aborted', async () => {
    const { ipc, recorder } = setup()
    ipc.onCommand('plugin:recording|actions_ready', () => null)
    const stopped = new AbortController()
    stopped.abort()

    await recorder.actionsReady({ signal: stopped.signal })

    expect(commands(ipc)).toEqual([])
  })

  it('logs plugin events the bridge cannot deliver', async () => {
    const { logger, recorder } = setup({ pluginEvents: false })
    recorder.subscribeLevel(() => {})

    await expect.poll(() => logger.getErrors().length).toBe(1)
    expect(logger.getErrors()[0]?.message).toBe('recording plugin events unavailable')
  })
})
