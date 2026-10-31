import { describe, expect, it, vi } from 'vitest'
import {
  createTestAudioRecorderService,
  createTestClockService,
  createTestLoggerService,
  createTestPlatformService,
} from '../testing/index.ts'
import type { AudioRecorderFinalSegment } from './audio-recorder-service.ts'
import {
  createNativeActionService,
  type NativeRecordActionHandler,
} from './native-action-service.ts'

const ORPHANED: AudioRecorderFinalSegment = {
  audio: { kind: 'staged', path: '/staging/recording-1700000050000.part-001-end.m4a' },
  mimeType: 'audio/mp4',
  sessionStartedMs: 1_700_000_050_000,
  part: 1,
  end: true,
  durationMs: 30_000,
}

function setup(options?: { isNativeShell?: boolean }) {
  const recorder = createTestAudioRecorderService()
  const clock = createTestClockService()
  const logger = createTestLoggerService()
  const service = createNativeActionService({
    audioRecorder: recorder,
    clock,
    logger,
    platform: createTestPlatformService({ isNativeShell: options?.isNativeShell ?? true }),
  })
  const handler = {
    start: vi.fn<NativeRecordActionHandler['start']>().mockResolvedValue(undefined),
    onReconciledSegment: vi.fn<NativeRecordActionHandler['onReconciledSegment']>(),
  }
  const methods = (): string[] => recorder.calls().map((call) => call.method)
  return { recorder, clock, logger, service, handler, methods }
}

describe('NativeActionService.open', () => {
  it('a recording that outlived its UI is stopped and handed over before the handshake', async () => {
    const { recorder, clock, service, handler, methods } = setup()
    await recorder.start({ segmentMs: 1, reminderMs: 1 })
    recorder.setStopResult(ORPHANED)

    service.open(handler)
    await clock.advance(0)

    expect(handler.onReconciledSegment).toHaveBeenCalledWith(ORPHANED)
    // Reconcile first: a queued "record" delivered at `actionsReady` can never
    // race the reconcile's stop.
    expect(methods()).toEqual(['start', 'status', 'stop', 'actionsReady'])
  })

  it('no live recording means no stop call', async () => {
    const { clock, service, handler, methods } = setup()

    service.open(handler)
    await clock.advance(0)

    expect(methods()).toEqual(['status', 'actionsReady'])
    expect(handler.onReconciledSegment).not.toHaveBeenCalled()
  })

  it('a too-short live recording is stopped and hands nothing over', async () => {
    const { recorder, clock, service, handler, methods } = setup()
    await recorder.start({ segmentMs: 1, reminderMs: 1 })

    service.open(handler)
    await clock.advance(0)

    expect(methods()).toContain('stop')
    expect(handler.onReconciledSegment).not.toHaveBeenCalled()
  })

  it('a failed reconcile is logged and the handshake still runs', async () => {
    const { recorder, clock, logger, service, handler, methods } = setup()
    const cause = new Error('nothing is recording')
    vi.spyOn(recorder, 'status').mockRejectedValue(cause)

    service.open(handler)
    await clock.advance(0)

    expect(logger.getWarnings()).toEqual([
      { message: 'reconciling a live native recording failed:', cause },
    ])
    expect(methods()).toContain('actionsReady')
  })

  it('disposing while the reconcile is pending skips the handshake', async () => {
    const { recorder, clock, service, handler, methods } = setup()
    const status = Promise.withResolvers<{ recording: boolean; elapsedMs: number }>()
    vi.spyOn(recorder, 'status').mockReturnValue(status.promise)

    const close = service.open(handler)
    await clock.advance(0)
    close()
    status.resolve({ recording: false, elapsedMs: 0 })
    await clock.advance(0)

    expect(methods()).not.toContain('actionsReady')
  })

  it('disposing during the handshake aborts its signal', async () => {
    const { recorder, clock, service, handler } = setup()
    const handshake = vi.spyOn(recorder, 'actionsReady').mockReturnValue(new Promise(() => {}))

    const close = service.open(handler)
    await clock.advance(0)
    const signal = handshake.mock.calls[0]?.[0]?.signal
    expect(signal?.aborted).toBe(false)
    close()

    expect(signal?.aborted).toBe(true)
  })

  it('recordAudio starts a memo, then confirms once the UI survived its window', async () => {
    const { recorder, clock, service, handler, methods } = setup()
    service.open(handler)
    await clock.advance(0)

    recorder.emitNativeAction({ action: 'recordAudio' })
    expect(handler.start).toHaveBeenCalledTimes(1)

    // Confirmation waits until the recording UI has survived presentation —
    // a crash in that window must leave the action queued for next launch.
    await clock.advance(1999)
    expect(methods()).not.toContain('actionPerformed')
    await clock.advance(1)
    expect(methods()).toContain('actionPerformed')
  })

  it('a repeat delivery restarts the confirm window and confirms once', async () => {
    const { recorder, clock, service, handler, methods } = setup()
    service.open(handler)
    await clock.advance(0)

    recorder.emitNativeAction({ action: 'recordAudio' })
    await clock.advance(1500)
    recorder.emitNativeAction({ action: 'recordAudio' })
    await clock.advance(1500)
    expect(methods()).not.toContain('actionPerformed')

    await clock.advance(500)
    expect(handler.start).toHaveBeenCalledTimes(2)
    expect(methods().filter((method) => method === 'actionPerformed')).toHaveLength(1)
  })

  it('unknown native actions are ignored', async () => {
    const { recorder, clock, service, handler, methods } = setup()
    service.open(handler)
    await clock.advance(0)

    recorder.emitNativeAction({ action: 'somethingElse' })
    await clock.advance(2000)

    expect(handler.start).not.toHaveBeenCalled()
    expect(methods()).not.toContain('actionPerformed')
  })

  it('an unavailable handshake is logged', async () => {
    const { recorder, clock, logger, service, handler } = setup()
    const cause = new Error('plugin missing')
    vi.spyOn(recorder, 'actionsReady').mockRejectedValue(cause)

    service.open(handler)
    await clock.advance(0)

    expect(logger.getErrors()).toEqual([
      { message: 'the native-action handshake is unavailable:', cause },
    ])
  })

  it('closing drops the pending confirmation and stops listening', async () => {
    const { recorder, clock, service, handler, methods } = setup()
    const close = service.open(handler)
    await clock.advance(0)
    recorder.emitNativeAction({ action: 'recordAudio' })

    close()
    await clock.advance(2000)
    recorder.emitNativeAction({ action: 'recordAudio' })

    expect(handler.start).toHaveBeenCalledTimes(1)
    expect(methods()).not.toContain('actionPerformed')
    expect(clock.pendingTimers()).toBe(0)
  })

  it('closing before the reconcile settles never subscribes', async () => {
    const { recorder, clock, service, handler, methods } = setup()
    const close = service.open(handler)
    close()
    await clock.advance(0)

    recorder.emitNativeAction({ action: 'recordAudio' })

    expect(handler.start).not.toHaveBeenCalled()
    expect(methods()).toEqual(['status'])
  })

  it('does nothing outside the native shell', async () => {
    const { recorder, clock, service, handler, methods } = setup({ isNativeShell: false })

    service.open(handler)
    await clock.advance(0)
    recorder.emitNativeAction({ action: 'recordAudio' })

    expect(methods()).toEqual([])
    expect(handler.start).not.toHaveBeenCalled()
  })
})
