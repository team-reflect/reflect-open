// The App Store screenshot sizes, each with the simulator that takes it.

export interface Device {
  /** The `simctl` device type. */
  simulator: string
  /** The size of the screenshot in px: the App Store size and the simulator screen. */
  canvas: readonly [width: number, height: number]
}

export const DEVICES = {
  iphone: { simulator: 'iPhone-18-Pro-Max', canvas: [1320, 2868] },
  'iphone-medium': { simulator: 'iPhone-18-Pro', canvas: [1206, 2622] },
  ipad: { simulator: 'iPad-Pro-13-inch-M5-12GB', canvas: [2064, 2752] },
  'ipad-11': { simulator: 'iPad-Pro-11-inch-M5-12GB', canvas: [1668, 2420] },
} as const satisfies Record<string, Device>

export type DeviceName = keyof typeof DEVICES

export const THEMES = ['light', 'dark'] as const

export type Theme = (typeof THEMES)[number]
