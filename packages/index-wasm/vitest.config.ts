import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: { label: 'index-wasm', color: 'magenta' },
    environment: 'node',
  },
})
