import { useId, type ReactElement, type ReactNode } from 'react'

/** A small heading over a bordered card whose rows are separated by hairlines. */
export function SettingsSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}): ReactElement {
  return (
    <section aria-label={title} className="mt-8 first:mt-0">
      <h2 className="px-1 text-[13px] font-semibold text-text">{title}</h2>
      <div className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">
        {children}
      </div>
    </section>
  )
}

interface SettingsSwitchRowProps {
  legend: string
  description: string
  checked: boolean
  /** True until the stored value has been read. */
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}

/** Copy on the left, a 36x20 switch pinned right and centered with the row. */
export function SettingsSwitchRow({
  legend,
  description,
  checked,
  disabled = false,
  onCheckedChange,
}: SettingsSwitchRowProps): ReactElement {
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
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className="group inline-flex h-5 w-9 shrink-0 rounded-full bg-[var(--coolgray-300)] p-0.5 transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60 aria-checked:bg-accent dark:bg-white/15"
      >
        <span className="block size-4 rounded-full bg-white shadow-sm transition-transform duration-150 group-aria-checked:translate-x-4 dark:bg-text dark:group-aria-checked:bg-white" />
      </button>
    </div>
  )
}
