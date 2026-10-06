/**
 * state.test.ts ─ 状态的纯数据纪律(设计 §2.1 / §9.1):
 * createInitialState 结构、JSON 往返无损、canonicalJson 键序无关、stateHash 拒绝 Infinity / NaN / undefined、
 * clearScopedFlags 只清 @turn / @phase 后缀。全部同步脚本式,固定种子。
 */
import { describe, expect, it } from 'vitest'

import { createRandomController } from '@sgs/ai'

import type { GameConfig, GameState, JsonValue, Registry, StepResult } from '../src/index.js'
import {
  EngineError,
  EQUIP_SLOTS,
  Game,
  PLACEHOLDER_GENERAL_ID,
  STATE_SCHEMA_VERSION,
  UNLIMITED,
  assertCardInvariant,
  canonicalJson,
  clearScopedFlags,
  cloneJson,
  createInitialState,
  createStandardRegistry,
  hashJson,
  seedRng,
} from '../src/index.js'
import { TEST_OPTIONS, answer, buildGame, expectRequest, runSync } from '../src/testing/index.js'

const registry: Registry = createStandardRegistry()

/** 固定种子、n 名占位武将玩家的对局配置(测试选项:断言不变量、检测未消费 Flow、非法应答抛错) */
function configFor(seed: number, players = 5): GameConfig {
  return {
    seed,
    mode: 'ffa',
    players: Array.from({ length: players }, () => ({ general: null })),
    fixedDeckOrder: null,
    options: { ...TEST_OPTIONS },
  }
}

/** 用随机 AI 同步推进 steps 步(或直到结束),返回最后的 StepResult;用于取得"回合中途"的状态 */
function advanceRandomly(game: Game, seed: number, steps: number): StepResult {
  const n = game.state.players.length
  const controllers = Array.from({ length: n }, (_, p) => createRandomController(seed, p))
  let r = game.start()
  for (let i = 0; i < steps && r.type === 'request'; i++) {
    const controller = controllers[r.request.player]
    if (controller === undefined) throw new EngineError(`玩家 ${r.request.player} 没有控制器`)
    r = game.step(controller.respond(r.request))
  }
  return r
}

/** 递归把对象的键按插入顺序倒置(数组保序),用于构造"内容相同、键序不同"的值 */
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrder)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(record).reverse()) result[key] = reverseKeyOrder(record[key])
    return result
  }
  return value
}

/** 递归收集值中所有对象的键插入顺序(用于确认倒置确实改变了顺序) */
function keyOrders(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keyOrders(item, into)
  else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    into.push(keys.join(','))
    for (const key of keys) keyOrders(record[key], into)
  }
  return into
}

describe('createInitialState 结构', () => {
  const config: GameConfig = {
    ...configFor(42, 3),
    players: [{ general: PLACEHOLDER_GENERAL_ID }, { general: null }, { general: null }],
  }
  const state = createInitialState(config, registry)

  it('头部字段:schemaVersion / seed / rng(seedRng 搅拌后)/ mode / phase = setup', () => {
    expect(state.schemaVersion).toBe(STATE_SCHEMA_VERSION)
    expect(state.seed).toBe(42)
    expect(state.rng).toBe(seedRng(42))
    expect(Number.isInteger(state.rng)).toBe(true)
    expect(state.rng).toBeGreaterThanOrEqual(0)
    expect(state.rng).toBeLessThanOrEqual(0xffffffff)
    expect(state.mode).toBe('ffa')
    expect(state.phase).toBe('setup')
  })

  it('玩家数组:下标 = id = 座位号,武将按配置填(null 为空串),其余字段为开局前缺省', () => {
    expect(state.players).toHaveLength(3)
    state.players.forEach((p, i) => {
      expect(p.id).toBe(i)
      expect(p).toStrictEqual({
        id: i,
        general: i === 0 ? PLACEHOLDER_GENERAL_ID : '',
        kingdom: 'qun',
        gender: 'male',
        role: 'none',
        roleRevealed: false,
        hp: 0,
        maxHp: 0,
        alive: true,
        hand: [],
        equips: { weapon: null, armor: null, horse_offensive: null, horse_defensive: null },
        judgeArea: [],
        judgeAs: {},
        skills: [],
        flags: {},
        marks: {},
      })
      for (const slot of EQUIP_SLOTS) expect(p.equips[slot]).toBeNull()
    })
  })

  it('玩家之间不共享数组 / 对象(各自独立的 hand / equips / flags / marks)', () => {
    const [a, b] = state.players
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    if (a === undefined || b === undefined) return
    expect(a.hand).not.toBe(b.hand)
    expect(a.equips).not.toBe(b.equips)
    expect(a.flags).not.toBe(b.flags)
    expect(a.marks).not.toBe(b.marks)
    expect(a.judgeArea).not.toBe(b.judgeArea)
    expect(a.skills).not.toBe(b.skills)
  })

  it('牌区:全部牌按 id 升序在牌堆(长度 = registry.deck.length = 108),其余牌区为空', () => {
    expect(registry.deck).toHaveLength(108)
    expect(state.drawPile).toStrictEqual(registry.deck.map((c) => c.id))
    expect(state.drawPile).toStrictEqual(Array.from({ length: 108 }, (_, i) => i))
    expect(state.discardPile).toStrictEqual([])
    expect(state.processing).toStrictEqual([])
    expect(() => assertCardInvariant({ state, registry })).not.toThrow()
  })

  it('牌堆数组是新数组,不与 registry.deck 共享', () => {
    const fresh = createInitialState(config, registry)
    expect(fresh.drawPile).not.toBe(state.drawPile)
    fresh.drawPile.pop()
    expect(state.drawPile).toHaveLength(108)
    expect(registry.deck).toHaveLength(108)
  })

  it('回合 / 栈 / 计数器 / 标记 / 结果为开局前缺省', () => {
    expect(state.turn).toBeNull()
    expect(state.turnCount).toBe(0)
    expect(state.lastTurnPlayer).toBeNull()
    expect(state.turnQueue).toStrictEqual([])
    expect(state.stack).toStrictEqual([])
    expect(state.nextEventId).toBe(1)
    expect(state.nextRequestId).toBe(1)
    expect(state.flags).toStrictEqual({})
    expect(state.result).toBeNull()
  })

  it('字段集合恰为设计 §2.1 列出的 17 个键', () => {
    expect(Object.keys(state).sort()).toStrictEqual(
      [
        'schemaVersion',
        'seed',
        'rng',
        'mode',
        'phase',
        'players',
        'drawPile',
        'discardPile',
        'processing',
        'turn',
        'turnCount',
        'lastTurnPlayer',
        'turnQueue',
        'stack',
        'nextEventId',
        'nextRequestId',
        'flags',
        'result',
      ].sort(),
    )
  })

  it('同配置两次调用深度相等;不同种子只有 seed / rng 不同', () => {
    expect(createInitialState(config, registry)).toStrictEqual(state)
    const other = createInitialState({ ...config, seed: 43 }, registry)
    expect(other.seed).toBe(43)
    expect(other.rng).not.toBe(state.rng)
    expect({ ...other, seed: 42, rng: state.rng }).toStrictEqual(state)
  })

  it('玩家数随配置变化(2 人 / 8 人)', () => {
    expect(createInitialState(configFor(1, 2), registry).players).toHaveLength(2)
    expect(createInitialState(configFor(1, 8), registry).players).toHaveLength(8)
  })
})

describe('GameState JSON 往返', () => {
  it('开局前状态 JSON 往返深度相等(无 undefined、无类实例)', () => {
    const state = createInitialState(configFor(7), registry)
    const back: unknown = JSON.parse(JSON.stringify(state))
    expect(back).toStrictEqual(state)
    expect(cloneJson(state)).toStrictEqual(state)
  })

  it('回合中途(栈非空、turn 非 null)的状态 JSON 往返深度相等且 hash 不变', () => {
    const game = new Game(configFor(7), registry)
    const r = advanceRandomly(game, 7, 40)
    expect(r.type).toBe('request')
    const state = game.state
    expect(state.phase).toBe('running')
    expect(state.stack.length).toBeGreaterThan(0)
    expect(state.turn).not.toBeNull()
    const back = cloneJson(state)
    expect(back).toStrictEqual(state)
    expect(hashJson(back)).toBe(game.stateHash())
    expect(() => assertCardInvariant({ state: back, registry })).not.toThrow()
  })

  it('栈上的事件 JSON 往返后 parentId 链与 tags 仍完整', () => {
    const game = new Game(configFor(11), registry)
    advanceRandomly(game, 11, 25)
    const back = cloneJson(game.state)
    expect(back.stack.length).toBeGreaterThan(0)
    back.stack.forEach((ev, i) => {
      const parent = back.stack[i - 1]
      expect(ev.parentId).toBe(parent === undefined ? null : parent.id)
      expect(ev.cancelled).toBe(false)
      expect(ev.tags).toStrictEqual({})
    })
    expect(back.stack).toStrictEqual(game.state.stack)
  })

  it('对局结束后的状态 JSON 往返深度相等', () => {
    const game = new Game(configFor(3, 3), registry)
    const controllers = Array.from({ length: 3 }, (_, p) => createRandomController(3, p))
    const r = runSync(game, controllers)
    expect(r.type).toBe('over')
    expect(game.state.phase).toBe('over')
    expect(game.state.result).not.toBeNull()
    expect(cloneJson(game.state)).toStrictEqual(game.state)
    expect(hashJson(cloneJson(game.state))).toBe(game.stateHash())
  })

  it('回合边界快照 base 往返后可 fromState 重入,重入后的状态 hash 与 base 一致(日志不进 hash)', () => {
    const game = new Game(configFor(5), registry)
    advanceRandomly(game, 5, 60)
    const snap = game.snapshot()
    expect(snap.base).not.toBeNull()
    if (snap.base === null) return
    const base = cloneJson(snap.base)
    expect(base).toStrictEqual(snap.base)
    expect(base.stack).toStrictEqual([])
    expect(base.turn).toBeNull()
    const resumed = Game.fromState(base, registry, snap.config)
    expect(resumed.log).toHaveLength(0)
    expect(game.log.length).toBeGreaterThan(0)
    expect(resumed.stateHash()).toBe(hashJson(base))
    expect(resumed.state).toStrictEqual(base)
    expect(resumed.state).not.toBe(base)
  })

  it('fromState 克隆状态:调用方的对象不被对局推进修改', () => {
    const game = new Game(configFor(9), registry)
    advanceRandomly(game, 9, 60)
    const base = game.snapshot().base
    expect(base).not.toBeNull()
    if (base === null) return
    const before = cloneJson(base)
    const resumed = Game.fromState(base, registry, game.config)
    resumed.start()
    expect(base).toStrictEqual(before)
    expect(resumed.state.turnCount).toBe(before.turnCount + 1)
  })

  it('fromState 拒绝栈非空、已结束或结构版本不一致的状态', () => {
    const running = new Game(configFor(2, 3), registry)
    advanceRandomly(running, 2, 10)
    expect(running.state.stack.length).toBeGreaterThan(0)
    expect(() => Game.fromState(running.state, registry, running.config)).toThrow(EngineError)

    const finished = new Game(configFor(2, 3), registry)
    runSync(
      finished,
      Array.from({ length: 3 }, (_, p) => createRandomController(2, p)),
    )
    expect(() => Game.fromState(finished.state, registry, finished.config)).toThrow(EngineError)

    const stale = createInitialState(configFor(2, 3), registry)
    stale.phase = 'running'
    stale.schemaVersion = STATE_SCHEMA_VERSION + 1
    expect(() => Game.fromState(stale, registry, configFor(2, 3))).toThrow(/版本/)
  })
})

describe('canonicalJson 键序无关', () => {
  it('对象键按码元升序输出,数组保序,输出为合法 JSON', () => {
    const value = { b: [3, { z: null, a: 'x' }], a: true, A: 1.5, 中: -2 }
    const text = canonicalJson(value)
    expect(text).toBe('{"A":1.5,"a":true,"b":[3,{"a":"x","z":null}],"中":-2}')
    expect(JSON.parse(text)).toStrictEqual(value)
  })

  it('键插入顺序不同的等值对象产生相同的字符串与哈希', () => {
    const x = { k1: 1, k2: { n1: [1, 2], n2: 'a' }, k3: null }
    const y = { k3: null, k2: { n2: 'a', n1: [1, 2] }, k1: 1 }
    expect(Object.keys(x)).not.toStrictEqual(Object.keys(y))
    expect(canonicalJson(x)).toBe(canonicalJson(y))
    expect(hashJson(x)).toBe(hashJson(y))
  })

  it('数组顺序参与规范化(不是集合语义)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
    expect(hashJson({ a: [1, 2] })).not.toBe(hashJson({ a: [2, 1] }))
  })

  it('字符串按 JSON 规则转义;数字 / 布尔 / null 原样;Object.create(null) 视为纯对象', () => {
    expect(canonicalJson('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"')
    expect(canonicalJson(0)).toBe('0')
    expect(canonicalJson(-1.25)).toBe('-1.25')
    expect(canonicalJson(UNLIMITED)).toBe('1000000')
    expect(canonicalJson(false)).toBe('false')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson([])).toBe('[]')
    expect(canonicalJson({})).toBe('{}')
    const bare: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    bare['b'] = 1
    bare['a'] = 2
    expect(canonicalJson(bare)).toBe('{"a":2,"b":1}')
  })

  it('整个 GameState 递归倒置键序后 canonicalJson 与 stateHash 不变', () => {
    const game = new Game(configFor(13), registry)
    advanceRandomly(game, 13, 50)
    const state = game.state
    const reversed = reverseKeyOrder(state) as GameState
    expect(keyOrders(reversed)).not.toStrictEqual(keyOrders(state))
    expect(reversed).toStrictEqual(state)
    expect(canonicalJson(reversed)).toBe(canonicalJson(state))
    expect(hashJson(reversed)).toBe(game.stateHash())
    expect(JSON.parse(canonicalJson(state))).toStrictEqual(state)
  })

  it('stateHash 为 14 位十六进制;同种子同步数两局相等,状态不同则不同', () => {
    const a = new Game(configFor(21), registry)
    const b = new Game(configFor(21), registry)
    advanceRandomly(a, 21, 30)
    advanceRandomly(b, 21, 30)
    expect(a.stateHash()).toMatch(/^[0-9a-f]{14}$/)
    expect(a.stateHash()).toBe(b.stateHash())
    expect(a.stateHash()).toBe(hashJson(a.state))
    const c = new Game(configFor(22), registry)
    advanceRandomly(c, 22, 30)
    expect(c.stateHash()).not.toBe(a.stateHash())
  })
})

describe('stateHash 拒绝非纯数据', () => {
  /** 以 fromState 克隆出一个可随意篡改的运行中状态 */
  function corruptible(): Game {
    const state = createInitialState(configFor(1, 2), registry)
    state.phase = 'running'
    return Game.fromState(state, registry, configFor(1, 2))
  }

  it('Infinity / -Infinity 进入 flags 时抛 EngineError 并指出路径', () => {
    const game = corruptible()
    game.state.flags['bad'] = Infinity
    expect(() => game.stateHash()).toThrow(EngineError)
    expect(() => game.stateHash()).toThrow(/\$\.flags\.bad/)
    game.state.flags['bad'] = -Infinity
    expect(() => game.stateHash()).toThrow(EngineError)
  })

  it('NaN 进入玩家 flags 的嵌套数组时抛错并指出下标路径', () => {
    const game = corruptible()
    const p = game.state.players[0]
    expect(p).toBeDefined()
    if (p === undefined) return
    p.flags['arr'] = [1, NaN]
    expect(() => game.stateHash()).toThrow(EngineError)
    expect(() => game.stateHash()).toThrow(/\$\.players\[0\]\.flags\.arr\[1\]/)
  })

  it('undefined 作为对象属性或数组元素时抛错', () => {
    const game = corruptible()
    const flags = game.state.flags as Record<string, unknown>
    flags['missing'] = undefined
    expect(() => game.stateHash()).toThrow(EngineError)
    expect(() => game.stateHash()).toThrow(/undefined/)
    delete flags['missing']
    expect(() => game.stateHash()).not.toThrow()
    flags['list'] = [undefined]
    expect(() => game.stateHash()).toThrow(EngineError)
  })

  it('函数、Map / Set / Date 等非纯对象抛错;顶层 undefined 亦抛错', () => {
    expect(() => hashJson({ f: () => 1 })).toThrow(EngineError)
    expect(() => hashJson({ m: new Map() })).toThrow(/非纯对象/)
    expect(() => hashJson({ s: new Set([1]) })).toThrow(/非纯对象/)
    expect(() => hashJson({ d: new Date(0) })).toThrow(/非纯对象/)
    expect(() => hashJson(undefined)).toThrow(EngineError)
    expect(() => hashJson(Symbol('x'))).toThrow(EngineError)
    expect(() => hashJson(10n)).toThrow(EngineError)
  })

  it('UNLIMITED 与普通有限数值通过校验;篡改撤销后 hash 复原', () => {
    const game = corruptible()
    const before = game.stateHash()
    game.state.flags['limit'] = UNLIMITED
    expect(() => game.stateHash()).not.toThrow()
    expect(game.stateHash()).not.toBe(before)
    delete game.state.flags['limit']
    expect(game.stateHash()).toBe(before)
  })

  it('随机 AI 对局全程每个等待点与结束时 stateHash 都可计算(状态始终是纯数据)', () => {
    const game = new Game(configFor(17, 4), registry)
    const controllers = Array.from({ length: 4 }, (_, p) => createRandomController(17, p))
    let r = game.start()
    let checked = 0
    while (r.type === 'request') {
      expect(() => game.stateHash()).not.toThrow()
      checked++
      const controller = controllers[r.request.player]
      if (controller === undefined) throw new EngineError('没有控制器')
      r = game.step(controller.respond(r.request))
    }
    expect(checked).toBeGreaterThan(0)
    expect(() => game.stateHash()).not.toThrow()
  })
})

describe('clearScopedFlags 只清 @turn / @phase 后缀', () => {
  /** 构造各层都带 persistent / @turn / @phase / 干扰键的状态 */
  function scopedState(): GameState {
    const state = createInitialState(configFor(1, 2), registry)
    const fill = (): Record<string, JsonValue> => ({
      keep: 1,
      'x@turn': 2,
      'y@phase': 3,
      'z@turn@phase': 4,
      'w@phase@turn': 5,
      'a@turnX': 6,
      'b@phaseY': 7,
      '@turn': 8,
      '@phase': 9,
      'c@Turn': 10,
      'd@TURN': 11,
    })
    state.flags = fill()
    for (const p of state.players) {
      p.flags = fill()
      p.marks = fill() as Record<string, number>
    }
    state.turn = {
      player: 0,
      phase: 'play',
      skipPhases: [],
      history: [],
      counters: fill() as Record<string, number>,
    }
    return state
  }

  const afterTurn = {
    keep: 1,
    'y@phase': 3,
    'z@turn@phase': 4,
    'a@turnX': 6,
    'b@phaseY': 7,
    '@phase': 9,
    'c@Turn': 10,
    'd@TURN': 11,
  }
  const afterPhase = {
    keep: 1,
    'x@turn': 2,
    'w@phase@turn': 5,
    'a@turnX': 6,
    'b@phaseY': 7,
    '@turn': 8,
    'c@Turn': 10,
    'd@TURN': 11,
  }
  const afterBoth = { keep: 1, 'a@turnX': 6, 'b@phaseY': 7, 'c@Turn': 10, 'd@TURN': 11 }

  it("'@turn' 清掉全局 flags、各玩家 flags / marks、turn.counters 中以 @turn 结尾的键,其余保留", () => {
    const state = scopedState()
    clearScopedFlags(state, '@turn')
    expect(state.flags).toStrictEqual(afterTurn)
    for (const p of state.players) {
      expect(p.flags).toStrictEqual(afterTurn)
      expect(p.marks).toStrictEqual(afterTurn)
    }
    expect(state.turn?.counters).toStrictEqual(afterTurn)
  })

  it("'@phase' 只清以 @phase 结尾的键,@turn 键保留", () => {
    const state = scopedState()
    clearScopedFlags(state, '@phase')
    expect(state.flags).toStrictEqual(afterPhase)
    for (const p of state.players) {
      expect(p.flags).toStrictEqual(afterPhase)
      expect(p.marks).toStrictEqual(afterPhase)
    }
    expect(state.turn?.counters).toStrictEqual(afterPhase)
  })

  it('先后清两种后缀后只剩持久键与"后缀不在末尾"的干扰键;重复调用幂等', () => {
    const state = scopedState()
    clearScopedFlags(state, '@phase')
    clearScopedFlags(state, '@turn')
    expect(state.flags).toStrictEqual(afterBoth)
    const snapshot = cloneJson(state)
    clearScopedFlags(state, '@turn')
    clearScopedFlags(state, '@phase')
    expect(state).toStrictEqual(snapshot)
  })

  it('不触碰 flags / marks / counters 以外的字段,turn 为 null 时不抛错', () => {
    const state = scopedState()
    const before = cloneJson(state)
    clearScopedFlags(state, '@turn')
    expect({ ...state, flags: null, players: null, turn: null }).toStrictEqual({
      ...before,
      flags: null,
      players: null,
      turn: null,
    })
    state.players.forEach((p, i) => {
      const b = before.players[i]
      expect(b).toBeDefined()
      if (b === undefined) return
      expect({ ...p, flags: null, marks: null }).toStrictEqual({ ...b, flags: null, marks: null })
    })
    expect(state.turn?.history).toStrictEqual(before.turn?.history)
    expect(state.turn?.skipPhases).toStrictEqual(before.turn?.skipPhases)

    const noTurn = scopedState()
    noTurn.turn = null
    expect(() => clearScopedFlags(noTurn, '@turn')).not.toThrow()
    expect(() => clearScopedFlags(noTurn, '@phase')).not.toThrow()
    expect(noTurn.flags).toStrictEqual(afterBoth)
  })

  it('空标记表与无后缀键的表保持不变', () => {
    const state = createInitialState(configFor(1, 2), registry)
    state.flags = { only: 'persistent' }
    clearScopedFlags(state, '@turn')
    clearScopedFlags(state, '@phase')
    expect(state.flags).toStrictEqual({ only: 'persistent' })
    for (const p of state.players) {
      expect(p.flags).toStrictEqual({})
      expect(p.marks).toStrictEqual({})
    }
  })

  it('对局推进中:@phase 键在阶段结束时清除,@turn 键在回合结束时清除,持久键保留', () => {
    const scoped = { 'p@turn': 1, 'p@phase': 2, p: 3 }
    const game = buildGame(registry, {
      players: [
        { hand: [], flags: { ...scoped }, marks: { ...scoped } },
        { hand: [], flags: { ...scoped }, marks: { ...scoped } },
      ],
      flags: { ...scoped },
    })
    const r0 = game.start()
    expect(r0.type).toBe('request')
    // 0 号位回合:准备 / 判定 / 摸牌阶段已结束 ⇒ @phase 已清;回合未结束 ⇒ @turn 仍在
    expect(expectRequest(game, 'play').player).toBe(0)
    const midTurn = { 'p@turn': 1, p: 3 }
    expect(game.state.flags).toStrictEqual(midTurn)
    for (const p of game.state.players) {
      expect(p.flags).toStrictEqual(midTurn)
      expect(p.marks).toStrictEqual(midTurn)
    }
    // 结束出牌 ⇒ 弃牌 / 结束阶段 ⇒ 回合结束清 @turn ⇒ 1 号位回合的出牌请求
    const r1 = answer(game, { action: 'end' })
    expect(r1.type).toBe('request')
    expect(expectRequest(game, 'play').player).toBe(1)
    expect(game.state.turnCount).toBe(2)
    const persistent = { p: 3 }
    expect(game.state.flags).toStrictEqual(persistent)
    for (const p of game.state.players) {
      expect(p.flags).toStrictEqual(persistent)
      expect(p.marks).toStrictEqual(persistent)
    }
  })
})
