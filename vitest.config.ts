import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'tools/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
    },
  },
})
