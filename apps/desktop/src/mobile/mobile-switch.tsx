import { lazy, Suspense, type ReactElement } from 'react'

const BaseUiSwitch = lazy(async () => {
  const { Switch } = await import('@/components/ui/switch.tsx')
  return { default: Switch }
})

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
      <BaseUiSwitch {...props} />
    </Suspense>
  )
}

function NativeSwitch({
  checked,
  onCheckedChange,
  'aria-describedby': describedBy,
}: MobileSwitchProps): ReactElement {
  return (
    <input
      type="checkbox"

      /* @ts-expect-error: WebKit's switch attribute (Safari 17.4+), which React's input types lack. */
      switch=""

      role="switch"
      checked={checked}
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      aria-describedby={describedBy}
      className="shrink-0 accent-primary"
    />
  )
}
