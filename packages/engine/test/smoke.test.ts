import { describe, expect, it } from 'vitest'

import { ENGINE_VERSION } from '../src/index.js'

describe('engine 包冒烟', () => {
  it('能被导入', () => {
    expect(ENGINE_VERSION).toBe('0.0.0')
  })
})
