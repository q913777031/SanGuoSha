import { describe, expect, it } from 'vitest'

import { createRandomController } from '@sgs/ai'

import type { GameConfig } from '../src/index.js'
import { Game, assertCardInvariant, createStandardRegistry, runGame } from '../src/index.js'
import { runSync } from '../src/testing/index.js'

const PLAYERS = 5

function configFor(seed: number): GameConfig {
  return {
    seed,
    mode: 'ffa',
    players: Array.from({ length: PLAYERS }, () => ({ general: null })),
    fixedDeckOrder: null,
    options: {
      assertInvariants: true,
      detectUnconsumedFlows: true,
      invalidResponsePolicy: 'throw',
    },
  }
}

describe('engine 冒烟', () => {
  it('createStandardRegistry 构建成功且牌堆长 108', () => {
    const registry = createStandardRegistry()
    expect(registry.deck.length).toBe(108)
    expect(registry.card('slash')).not.toBeNull()
    expect(registry.card('jink')).not.toBeNull()
    expect(registry.card('peach')).not.toBeNull()
    expect(registry.card('nullification')).toBeNull()
    expect(registry.mode('ffa').id).toBe('ffa')
    expect(registry.contentHash).toMatch(/^[0-9a-f]{14}$/)
  })

  it('5 人随机 AI 对局 20 局(不同 seed)跑完无异常、不变量成立、同 seed hash 一致', () => {
    const registry = createStandardRegistry()
    for (let seed = 1; seed <= 20; seed++) {
      const hashes: string[] = []
      for (let run = 0; run < 2; run++) {
        const game = new Game(configFor(seed), registry)
        const controllers = Array.from({ length: PLAYERS }, (_, p) =>
          createRandomController(seed, p),
        )
        const r = runSync(game, controllers)
        expect(r.type).toBe('over')
        expect(game.state.phase).toBe('over')
        expect(game.state.stack).toEqual([])
        expect(game.state.result).not.toBeNull()
        expect(game.state.turnCount).toBeGreaterThan(0)
        expect(game.state.players.filter((p) => p.alive).length).toBeLessThanOrEqual(1)
        expect(() => assertCardInvariant({ state: game.state, registry })).not.toThrow()
        hashes.push(game.stateHash())
      }
      expect(hashes[0]).toBe(hashes[1])
    }
  })

  it('async runGame 也能用随机 AI 打完一局', async () => {
    const registry = createStandardRegistry()
    const game = new Game(configFor(42), registry)
    const controllers = Array.from({ length: PLAYERS }, (_, p) => createRandomController(42, p))
    const result = await runGame(game, controllers)
    expect(result.reason).toBe('lastSurvivor')
    expect(result.winners.length).toBe(1)
  })
})
