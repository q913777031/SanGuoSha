import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // 引擎测试用随机 AI 跑对局;@sgs/ai 依赖 @sgs/engine,用别名而不是循环的 workspace 依赖
    alias: {
      '@sgs/ai': fileURLToPath(new URL('../ai/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'engine',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
})
