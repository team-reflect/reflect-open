import { lazy, Suspense, type ReactElement } from 'react'

const WebSwitch = lazy(async () => {
  const { Switch } = await import('@/components/ui/switch.tsx')
  return { default: Switch }
})

// https://caniuse.com/mdn-html_elements_input_switch
const supportsNativeSwitch = 'switch' in HTMLInputElement.prototype

interface MobileSwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  'aria-describedby'?: string | undefined
}

/**
 * A switch that WebKit draws as the system control where it can, and the
 * Base UI switch elsewhere.
 */
export function MobileSwitch(props: MobileSwitchProps): ReactElement {
  if (supportsNativeSwitch) {
    return <NativeSwitch {...props} />
  }
  return (
    <Suspense fallback={null}>
      <WebSwitch {...props} />
    </Suspense>
  )
}

function NativeSwitch({
  checked,
  onCheckedChange,
  'aria-describedby': describedBy,
}: MobileSwitchProps): ReactElement {
  // WebKit draws the switch in UIKit's 64x28 shape but keeps the old 31px
  // height, so by default it is 71x31, larger than a native `UISwitch`.
  // Setting both sides keeps WebKit's default size from applying. See
  // https://github.com/WebKit/WebKit/blob/22d0ea35487a67870e232b0bf385fd30833d246a/Source/WebCore/rendering/cocoa/RenderThemeCocoa.mm#L416-L417
  return (
    <input
      type="checkbox"
      /* @ts-expect-error: WebKit's switch attribute (Safari 17.4+), which React's input types lack. */
      switch=""
      role="switch"
      checked={checked}
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      aria-describedby={describedBy}
      className="h-7 w-16 shrink-0 accent-primary"
    />
  )
}
