import { useEffect, useRef, type ReactElement } from 'react'

interface RecordingLevelWaveformProps {
  /** Latest input level 0…1 (the plugin's ~10 Hz `recordingLevel` stream). */
  level: number
}

const BAR_COUNT = 48
const BAR_WIDTH = 2
const BAR_GAP = 2
const CSS_WIDTH = BAR_COUNT * (BAR_WIDTH + BAR_GAP) - BAR_GAP
const CSS_HEIGHT = 28
/** Average-power levels read quieter than desktop's peak sampling — boost. */
const LEVEL_GAIN = 2.5

/**
 * The mobile counterpart of `RecordingWaveform`: the same rolling
 * amplitude trace, fed by the native recorder's metering events instead of
 * an AnalyserNode on a MediaStream (the native recorder has no stream to
 * tap). A new bar lands per level event, scrolling left as the recording
 * grows; silence renders as the dotted baseline.
 */
export function RecordingLevelWaveform({ level }: RecordingLevelWaveformProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const barsRef = useRef<number[]>(Array.from({ length: BAR_COUNT }, () => 0))

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

    const bars = barsRef.current
    bars.push(Math.min(1, level * LEVEL_GAIN))
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
  }, [level])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="text-destructive"
      style={{ width: CSS_WIDTH, height: CSS_HEIGHT }}
    />
  )
}
