import { describe, expect, it } from 'vitest'

import { createRandomController } from '@sgs/ai'

import type { GameConfig, Snapshot, StepResult } from '../src/index.js'
import { EngineError, Game, createStandardRegistry } from '../src/index.js'

const registry = createStandardRegistry()

function configFor(seed: number, players: number): GameConfig {
  return {
    seed,
    mode: 'ffa',
    players: Array.from({ length: players }, () => ({ general: null })),
    fixedDeckOrder: null,
    options: {
      assertInvariants: true,
      detectUnconsumedFlows: true,
      invalidResponsePolicy: 'throw',
    },
  }
}

/** 快照经 JSON 文本往返(模拟落盘 / 传输) */
function roundTrip(snapshot: Snapshot): Snapshot {
  const parsed: unknown = JSON.parse(JSON.stringify(snapshot))
  return parsed as Snapshot
}

/** 回合边界记录:边界后第一个请求处的快照文本,及边界时已采纳的应答数 */
interface Boundary {
  snapshot: string
  responseIndex: number
}

/** 不中断的参照对局:随机 AI 打完,记录每个回合边界(边界后第一个请求处)的快照 */
function referenceRun(seed: number, players: number) {
  const game = new Game(configFor(seed, players), registry)
  const controllers = Array.from({ length: players }, (_, p) => createRandomController(seed, p))
  const boundaries: Boundary[] = []
  let turnCount = game.state.turnCount
  let r: StepResult = game.start()
  while (r.type === 'request') {
    if (game.state.turnCount !== turnCount) {
      turnCount = game.state.turnCount
      boundaries.push({
        snapshot: JSON.stringify(game.snapshot()),
        responseIndex: game.responses.length,
      })
    }
    const { player } = r.request
    r = game.step(controllers[player]!.respond(r.request))
  }
  return { game, boundaries }
}

describe('回合边界快照与恢复(serialize-resume)', () => {
  it('每个回合边界 snapshot → JSON → restore 后换用恢复的对局继续,终局 hash 与日志同不中断对局', () => {
    for (const [seed, players] of [
      [7, 4],
      [11, 5],
      [23, 8],
    ] as const) {
      const ref = referenceRun(seed, players)
      let game = new Game(configFor(seed, players), registry)
      const controllers = Array.from({ length: players }, (_, p) => createRandomController(seed, p))
      let turnCount = game.state.turnCount
      let restores = 0
      let r: StepResult = game.start()
      while (r.type === 'request') {
        if (game.state.turnCount !== turnCount) {
          turnCount = game.state.turnCount
          const snap = roundTrip(game.snapshot())
          expect(snap.base).not.toBeNull()
          expect(snap.responses).toEqual([])
          const restored = Game.restore(snap, registry)
          expect(restored.stateHash()).toBe(game.stateHash())
          expect(restored.pending).toEqual(game.pending)
          game = restored
          restores++
          r = { type: 'request', request: restored.pending!, logs: [] }
        }
        const { player } = r.request
        r = game.step(controllers[player]!.respond(r.request))
      }
      expect(restores).toBe(ref.game.state.turnCount)
      expect(game.state.phase).toBe('over')
      expect(game.state.result).toEqual(ref.game.state.result)
      expect(game.stateHash()).toBe(ref.game.stateHash())
      expect(game.log).toEqual(ref.game.log)
    }
  })

  it('从任一回合边界快照恢复后按同一应答序列推进到结束,hash 与不中断对局一致', () => {
    const ref = referenceRun(3, 5)
    const all = ref.game.responses
    expect(ref.boundaries.length).toBe(ref.game.state.turnCount)
    for (const b of ref.boundaries) {
      const game = Game.restore(roundTrip(JSON.parse(b.snapshot) as Snapshot), registry)
      let r: StepResult | null = null
      for (const response of all.slice(b.responseIndex)) r = game.step(response)
      expect(r?.type).toBe('over')
      expect(game.stateHash()).toBe(ref.game.stateHash())
    }
  })

  it('回合中途快照:base 为本回合开始前的边界状态,responses 只含本回合应答', () => {
    const seed = 5
    const players = 5
    const game = new Game(configFor(seed, players), registry)
    const controllers = Array.from({ length: players }, (_, p) => createRandomController(seed, p))
    let turnCount = game.state.turnCount
    let boundaryIndex = 0
    let checked = 0
    let r: StepResult = game.start()
    while (r.type === 'request') {
      if (game.state.turnCount !== turnCount) {
        turnCount = game.state.turnCount
        boundaryIndex = game.responses.length
      }
      if (game.responses.length > boundaryIndex) {
        const snap = game.snapshot()
        expect(snap.responses).toEqual(game.responses.slice(boundaryIndex))
        expect(snap.base).not.toBeNull()
        expect(snap.base!.stack).toEqual([])
        expect(snap.base!.turn).toBeNull()
        expect(snap.base!.turnCount).toBe(game.state.turnCount - 1)
        expect(snap.log).toEqual(game.log.slice(0, snap.log.length))
        checked++
      }
      const { player } = r.request
      r = game.step(controllers[player]!.respond(r.request))
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('restore 后 pending、视图与 stateHash 与中断前一致,且可再次快照', () => {
    const seed = 9
    const players = 4
    const game = new Game(configFor(seed, players), registry)
    const controllers = Array.from({ length: players }, (_, p) => createRandomController(seed, p))
    let r: StepResult = game.start()
    let steps = 0
    while (r.type === 'request') {
      if (steps++ % 3 === 0) {
        const snap = roundTrip(game.snapshot())
        const restored = Game.restore(snap, registry)
        const pending = game.pending!
        expect(restored.pending).toEqual(pending)
        expect(restored.stateHash()).toBe(game.stateHash())
        expect(restored.viewFor(pending.player)).toEqual(game.viewFor(pending.player))
        expect(roundTrip(restored.snapshot())).toEqual(snap)
      }
      const { player } = r.request
      r = game.step(controllers[player]!.respond(r.request))
    }
  })

  it('fromState 拒绝结算栈非空或已结束的状态', () => {
    const config = configFor(1, 4)
    const game = new Game(config, registry)
    const controllers = Array.from({ length: 4 }, (_, p) => createRandomController(1, p))
    let r: StepResult = game.start()
    expect(game.state.stack.length).toBeGreaterThan(0)
    expect(() => Game.fromState(game.state, registry, config)).toThrow(EngineError)
    while (r.type === 'request') {
      r = game.step(controllers[r.request.player]!.respond(r.request))
    }
    expect(game.state.phase).toBe('over')
    expect(game.state.stack).toEqual([])
    expect(() => Game.fromState(game.state, registry, config)).toThrow(EngineError)
  })
})
