import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: { label: 'db', color: 'magenta' },
  },
})
