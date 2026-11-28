// The App Store screenshot sizes, each with the simulator that takes it.

export interface Device {
  /** The `simctl` device type. */
  simulator: string
  /**
   * The size of the screenshot in px: the App Store size and the simulator
   * screen. A landscape size turns the simulator to landscape.
   */
  canvas: readonly [width: number, height: number]
  /** An iPhone Duo, closed: the outer screen. */
  closed?: true
}

export const DEVICES = {
  'iPhone-18-Pro': { simulator: 'iPhone-18-Pro', canvas: [1206, 2622] },
  'iPhone-Duo-outer': { simulator: 'iPhone-Duo', canvas: [1398, 2034], closed: true },
  'iPad-Pro-13-inch-M5-landscape': { simulator: 'iPad-Pro-13-inch-M5-12GB', canvas: [2752, 2064] },
} as const satisfies Record<string, Device>

export type DeviceName = keyof typeof DEVICES

export const THEMES = ['light', 'dark'] as const

export type Theme = (typeof THEMES)[number]
