import { describe, expect, it } from 'vitest'

import { createRandomController } from '@sgs/ai'

import type { GameConfig, Registry, Snapshot } from '../src/index.js'
import {
  Game,
  IncompatibleSnapshotError,
  STATE_SCHEMA_VERSION,
  createStandardRegistry,
} from '../src/index.js'
import { TEST_OPTIONS, runSync } from '../src/testing/index.js'

const PLAYERS = 5

function configFor(seed: number, players = PLAYERS): GameConfig {
  return {
    seed,
    mode: 'ffa',
    players: Array.from({ length: players }, () => ({ general: null })),
    fixedDeckOrder: null,
    options: { ...TEST_OPTIONS },
  }
}

/** 同 seed 随机 AI 打完一局,返回结束后的 Game */
function playOut(registry: Registry, seed: number, players = PLAYERS): Game {
  const game = new Game(configFor(seed, players), registry)
  const controllers = Array.from({ length: players }, (_, p) => createRandomController(seed, p))
  expect(runSync(game, controllers).type).toBe('over')
  return game
}

/** 全量回放快照(§9.2):base = null、responses = 自开局以来的全部应答 */
function replaySnapshot(game: Game): Snapshot {
  return { ...game.snapshot(), base: null, responses: [...game.responses], log: [] }
}

describe('回放确定性', () => {
  const registry = createStandardRegistry()

  it('同 seed 两局 stateHash 与 responses 均相等', () => {
    const a = playOut(registry, 7)
    const b = playOut(registry, 7)
    expect(a.responses.length).toBeGreaterThan(0)
    expect(b.responses).toEqual(a.responses)
    expect(b.stateHash()).toBe(a.stateHash())
  })

  it('base = null 快照 restore 回放后 stateHash 相等、log 长度一致', () => {
    const game = playOut(registry, 7)
    const replayed = Game.restore(replaySnapshot(game), registry)
    expect(replayed.state.phase).toBe('over')
    expect(replayed.pending).toBeNull()
    expect(replayed.stateHash()).toBe(game.stateHash())
    expect(replayed.log.length).toBe(game.log.length)
    expect(replayed.responses).toEqual(game.responses)
  })

  it('200 个 seed(5 人)逐一回放 hash 一致,且不同 seed 的终局 hash 互不相同', () => {
    const hashes: string[] = []
    for (let seed = 1; seed <= 200; seed++) {
      const game = playOut(registry, seed)
      const hash = game.stateHash()
      const replayed = Game.restore(replaySnapshot(game), registry)
      expect(replayed.stateHash(), `seed ${seed}`).toBe(hash)
      expect(replayed.log.length, `seed ${seed}`).toBe(game.log.length)
      hashes.push(hash)
    }
    expect(new Set(hashes).size).toBe(hashes.length)
  }, 60_000)
})

describe('快照版本门禁', () => {
  const registry = createStandardRegistry()
  const snapshot = replaySnapshot(playOut(registry, 3))

  it('未篡改的快照可以恢复', () => {
    expect(() => Game.restore(snapshot, registry)).not.toThrow()
  })

  it('篡改 contentHash 后 restore 抛 IncompatibleSnapshotError', () => {
    const bad = { ...snapshot, contentHash: `${snapshot.contentHash}x` }
    expect(() => Game.restore(bad, registry)).toThrow(IncompatibleSnapshotError)
  })

  it('篡改 schemaVersion 后 restore 抛 IncompatibleSnapshotError', () => {
    const bad = { ...snapshot, schemaVersion: STATE_SCHEMA_VERSION + 1 }
    expect(() => Game.restore(bad, registry)).toThrow(IncompatibleSnapshotError)
  })

  it('篡改 engineVersion 后 restore 抛 IncompatibleSnapshotError', () => {
    const bad = { ...snapshot, engineVersion: `${snapshot.engineVersion}-x` }
    expect(() => Game.restore(bad, registry)).toThrow(IncompatibleSnapshotError)
  })
})
