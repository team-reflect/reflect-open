// Generates the App Store screenshots of the iOS app.
//
//   pnpm store-screenshots [--skip-build] [--skip-capture] [--device <name>]...
//
// --skip-capture composes from the raw screens of the last run, for a change
// to the captions or the layout.
//
// See apps/ios/store-screenshots/README.md.

import { parseArgs } from 'node:util'

import { downloadBezels } from './bezels.ts'
import { build, capture } from './capture.ts'
import { compose, SCREENSHOTS_DIR } from './compose.ts'
import { DEVICES, type DeviceName } from './devices.ts'

const { values } = parseArgs({
  options: {
    'skip-build': { type: 'boolean', default: false },
    'skip-capture': { type: 'boolean', default: false },
    device: { type: 'string', multiple: true },
  },
})

const devices = (values.device ?? Object.keys(DEVICES)).map((name) => {
  if (!(name in DEVICES)) {
    throw new Error(`Unknown device ${name}. Devices: ${Object.keys(DEVICES).join(', ')}`)
  }
  return name as DeviceName
})

// The local date: the simulator shows the clock of the Mac.
const today = new Date().toLocaleDateString('en-CA')

if (!values['skip-capture']) {
  if (!values['skip-build']) {
    await build()
  }
  for (const device of devices) {
    console.log(`[store-screenshots] capture ${device}`)
    await capture(device, today)
  }
}
await downloadBezels(devices)
await compose(devices)
console.log(`[store-screenshots] ${SCREENSHOTS_DIR}`)
