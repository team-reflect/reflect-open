import { useId, type ReactElement } from 'react'
import { Switch } from '@/components/ui/switch'

interface SettingsSwitchFieldProps {
  /** The setting name shown beside the switch. */
  legend: string
  /** One-line explanation under the setting name. */
  description: string
  /** Whether the switch is enabled. */
  checked: boolean
  /** Persist the next switch state. */
  onCheckedChange: (checked: boolean) => void
}

/**
 * A compact settings row for boolean options: copy on the left, switch pinned
 * to the far right and vertically centered with the row.
 */
export function SettingsSwitchField({
  legend,
  description,
  checked,
  onCheckedChange,
}: SettingsSwitchFieldProps): ReactElement {
  const labelId = useId()
  const descriptionId = useId()

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0">
        <div id={labelId} className="text-sm font-medium text-text">
          {legend}
        </div>
        <p id={descriptionId} className="mt-0.5 text-xs text-text-muted">
          {description}
        </p>
      </div>
      <Switch
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="shrink-0"
      />
    </div>
  )
}
