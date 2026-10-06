import { describe, expect, it } from 'vitest'

import { createRandomController } from '@sgs/ai'

import type { GameConfig, PhaseEvent, TriggerSkill } from '../src/index.js'
import {
  EngineBrokenError,
  Game,
  assertCardInvariant,
  createStandardRegistry,
  defaultResponse,
} from '../src/index.js'
import type { SyncController } from '../src/testing/index.js'
import { TEST_OPTIONS, buildGame, createTestRegistry, runSync } from '../src/testing/index.js'

/** 假技能故意抛出的错误,用于区分引擎自身错误 */
class BoomError extends Error {
  constructor() {
    super('假技能故意抛错')
    this.name = 'BoomError'
  }
}

function configFor(seed: number, players: number): GameConfig {
  return {
    seed,
    mode: 'ffa',
    players: Array.from({ length: players }, () => ({ general: null })),
    fixedDeckOrder: null,
    options: { ...TEST_OPTIONS },
  }
}

/** 单局结束摘要 */
interface Outcome {
  seed: number
  players: number
  turns: number
  /** 检查过的出牌请求数 */
  playChecks: number
  /** 出牌请求(无结算在途)时处理区仍有牌的记录 */
  playLeaks: string[]
}

/** 跑一局随机 AI 对局并断言结束态;同时在每个出牌请求处记录处理区(见下方单独用例) */
function simulate(seed: number, players: number): Outcome {
  const registry = createStandardRegistry()
  const game = new Game(configFor(seed, players), registry)
  expect(game.options.assertInvariants).toBe(true)
  let playChecks = 0
  const playLeaks: string[] = []
  const controllers = Array.from({ length: players }, (_, p): SyncController => {
    const ai = createRandomController(seed, p)
    return (request) => {
      if (request.kind === 'play') {
        playChecks++
        const { processing } = game.state
        if (processing.length > 0) {
          playLeaks.push(`${players}人#${seed} 请求${request.id}:[${processing.join(',')}]`)
        }
      }
      return ai.respond(request)
    }
  })
  const r = runSync(game, controllers)
  const s = game.state
  expect(r.type).toBe('over')
  expect(s.phase).toBe('over')
  expect(s.result).not.toBeNull()
  expect(s.turnCount).toBeLessThanOrEqual(game.options.maxTurns)
  expect(s.stack).toEqual([])
  expect(() => assertCardInvariant({ state: s, registry })).not.toThrow()
  return { seed, players, turns: s.turnCount, playChecks, playLeaks }
}

const outcomes: Outcome[] = []

/** 跑 seed 1..count,记录摘要并返回平均回合数 */
function batch(count: number, players: number): number {
  let total = 0
  for (let seed = 1; seed <= count; seed++) {
    const outcome = simulate(seed, players)
    outcomes.push(outcome)
    total += outcome.turns
  }
  return total / count
}

describe('随机 AI 批量模拟', () => {
  it('5 人 100 局(seed 1..100)全部正常结束,平均回合数 > 1', () => {
    expect(batch(100, 5)).toBeGreaterThan(1)
  })

  it('8 人 30 局全部正常结束,平均回合数 > 1', () => {
    expect(batch(30, 8)).toBeGreaterThan(1)
  })

  it('2 人 30 局全部正常结束,平均回合数 > 1', () => {
    expect(batch(30, 2)).toBeGreaterThan(1)
  })

  // 设计 §4.7:善后移牌写在正常流程里,对局结束时状态保持原样,处理区可残留致死结算中的牌;
  // 因此在没有结算在途的出牌请求处检查"残留牌入弃牌堆",而不是在终局检查
  it('每个出牌请求时处理区为空(残留牌已入弃牌堆)', () => {
    expect(outcomes.length).toBe(160)
    expect(outcomes.reduce((n, o) => n + o.playChecks, 0)).toBeGreaterThan(0)
    expect(outcomes.flatMap((o) => o.playLeaks)).toEqual([])
  })
})

/** 在指定阶段开始时抛错的假技能 */
function boomSkill(phase: PhaseEvent['phase']): TriggerSkill<'Phase.start'> {
  return {
    id: `test:boom-${phase}`,
    name: '爆炸',
    description: `${phase} 阶段开始时抛错`,
    locked: true,
    lord: false,
    type: 'trigger',
    timings: ['Phase.start'],
    priority: 0,
    triggerWhenDead: false,
    canTrigger: (_ctx, ev, owner) => ev.player === owner && ev.phase === phase,
    *effect() {
      yield* []
      throw new BoomError()
    },
  }
}

function brokenGame(phase: PhaseEvent['phase']): Game {
  const skill = boomSkill(phase)
  const registry = createTestRegistry({ name: 'test-boom', version: '0', skills: [skill] })
  return buildGame(registry, { players: [{ skills: [skill.id] }, {}] })
}

describe('引擎损坏', () => {
  it('step 内抛出非 GameOver 异常后,再次 step 抛 EngineBrokenError', () => {
    const game = brokenGame('discard')
    let r = game.start()
    expect(r.type).toBe('request')
    let thrown: unknown = null
    for (let i = 0; i < 100 && thrown === null; i++) {
      if (r.type !== 'request') break
      const response = defaultResponse(r.request)
      try {
        r = game.step(response)
      } catch (e) {
        thrown = e
      }
    }
    expect(thrown).toBeInstanceOf(BoomError)
    expect(game.pending).toBeNull()
    expect(() => game.step({ kind: 'play', requestId: 0, action: 'end' })).toThrow(
      EngineBrokenError,
    )
  })

  it('start 内抛错后 step 抛 EngineBrokenError', () => {
    const game = brokenGame('prepare')
    expect(() => game.start()).toThrow(BoomError)
    expect(() => game.step({ kind: 'play', requestId: 0, action: 'end' })).toThrow(
      EngineBrokenError,
    )
  })
})
