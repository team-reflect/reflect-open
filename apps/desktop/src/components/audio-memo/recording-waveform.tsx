import { useEffect, useRef, type ReactElement } from 'react'

interface RecordingWaveformProps {
  /** The live microphone stream (from the audio-memo provider). */
  stream: MediaStream
}

const BAR_COUNT = 48
const BAR_WIDTH = 2
const BAR_GAP = 2
const SAMPLE_INTERVAL_MS = 60
const CSS_WIDTH = BAR_COUNT * (BAR_WIDTH + BAR_GAP) - BAR_GAP
const CSS_HEIGHT = 28

/**
 * The rolling input-level trace shown while recording: a new amplitude bar
 * every tick, scrolling left as the recording grows (silence renders as the
 * dotted baseline). Purely presentational — it taps the stream through its
 * own AudioContext and owns that lifecycle.
 */
export function RecordingWaveform({ stream }: RecordingWaveformProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) {
      return
    }
    const scale = window.devicePixelRatio || 1
    canvas.width = CSS_WIDTH * scale
    canvas.height = CSS_HEIGHT * scale
    context.scale(scale, scale)
    // The canvas carries a text color class; bars inherit the theme through it.
    const color = getComputedStyle(canvas).color

    let audioContext: AudioContext
    let source: MediaStreamAudioSourceNode
    try {
      audioContext = new AudioContext()
      source = audioContext.createMediaStreamSource(stream)
    } catch {
      // Context limit reached or the stream already died — keep the static
      // baseline rather than crash the tree over a decoration.
      return
    }
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    const bars: number[] = Array.from({ length: BAR_COUNT }, () => 0)

    let lastSampleAt = 0
    let frame = requestAnimationFrame(function loop(now: number) {
      if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
        lastSampleAt = now
        analyser.getByteTimeDomainData(samples)
        let peak = 0
        for (const sample of samples) {
          peak = Math.max(peak, Math.abs(sample - 128) / 128)
        }
        bars.push(Math.min(1, peak * 1.4))
        bars.splice(0, bars.length - BAR_COUNT)

        context.clearRect(0, 0, CSS_WIDTH, CSS_HEIGHT)
        context.fillStyle = color
        for (const [index, amplitude] of bars.entries()) {
          const height = Math.max(BAR_WIDTH, amplitude * CSS_HEIGHT)
          const left = index * (BAR_WIDTH + BAR_GAP)
          const top = (CSS_HEIGHT - height) / 2
          // roundRect is Safari 16+; an un-updated older WebKit still records,
          // it just gets square bars instead of a crash.
          if (typeof context.roundRect === 'function') {
            context.beginPath()
            context.roundRect(left, top, BAR_WIDTH, height, BAR_WIDTH / 2)
            context.fill()
          } else {
            context.fillRect(left, top, BAR_WIDTH, height)
          }
        }
      }
      frame = requestAnimationFrame(loop)
    })

    return () => {
      cancelAnimationFrame(frame)
      source.disconnect()
      void audioContext.close()
    }
  }, [stream])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="text-destructive"
      style={{ width: CSS_WIDTH, height: CSS_HEIGHT }}
    />
  )
}
