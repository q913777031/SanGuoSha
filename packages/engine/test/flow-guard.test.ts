/**
 * flow-guard.test.ts ─ 未消费 Flow 检测(设计 §4.7 / EngineOptions.detectUnconsumedFlows)与 finally 内 yield 的 lint 规则。
 * 用 0 号位武将上的假锁定技(Turn.start)漏写 yield*:
 *  detectUnconsumedFlows=true 时 Game.start 抛 EngineError(消息含 "never consumed");
 *  =false 时不抛,漏掉的 Flow 静默不执行;正确 yield* 的同类代码不误报。
 * 全部同步脚本式(Game.start / step),固定种子。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

import type { CardId, CardName, Ctx, Flow, Game, Registry } from '../src/index.js'
import {
  EngineError,
  askCard,
  byName,
  createFlowGuard,
  defaultResponse,
  runEvent,
} from '../src/index.js'
import { buildGame, createTestRegistry, expectRequest } from '../src/testing/index.js'

const SEED = 7

/** 牌表中第 nth 张名为 name 的牌 id */
function cardNamed(registry: Registry, name: CardName, nth = 0): CardId {
  const id = registry.deck.filter((c) => c.name === name).map((c) => c.id)[nth]
  if (id === undefined) throw new EngineError(`牌表中没有第 ${nth} 张 ${name}`)
  return id
}

/** 让 owner 摸 1 张的 DrawCards 事件 Flow */
function drawOne(ctx: Ctx): Flow<unknown> {
  return runEvent(ctx, { kind: 'DrawCards', player: 0, count: 1, reason: 'skill', cards: [] })
}

/** 询问 1 号位打出闪的 askCard Flow */
function askJink(ctx: Ctx): Flow<unknown> {
  return askCard(ctx, {
    player: 1,
    pattern: byName('jink'),
    mode: 'play',
    targets: [],
    againstId: null,
    reasonId: null,
    prompt: { key: 'test.jink', args: {} },
  })
}

/** 假技能体:接收 ctx,返回(或不返回)要运行的 Flow */
type Body = (ctx: Ctx) => Flow<void>

/** 0 号位挂一个 Turn.start 锁定技(effect = body),1 号位手持一张闪;固定种子开局 */
function gameWith(body: Body, detectUnconsumedFlows: boolean): Game {
  const base = createTestRegistry()
  const registry = createTestRegistry({
    name: 'test-flow-guard',
    version: '0.0.0',
    cards: [],
    skills: [
      {
        id: 'probe',
        name: 'probe',
        description: '测试用:在 Turn.start 运行给定 Flow',
        type: 'trigger',
        timings: ['Turn.start'],
        priority: 0,
        locked: true,
        lord: false,
        triggerWhenDead: false,
        canTrigger: (_ctx, _ev, owner) => owner === 0,
        effect: (ctx) => body(ctx),
      },
    ],
    generals: [
      { id: 'gProbe', name: 'gProbe', kingdom: 'wei', gender: 'male', maxHp: 4, skills: ['probe'] },
    ],
  })
  return buildGame(
    registry,
    {
      seed: SEED,
      players: [{ general: 'gProbe' }, { hand: [cardNamed(base, 'jink')] }],
    },
    { detectUnconsumedFlows },
  )
}

/** 漏写 yield* 的 runEvent:Flow 被创建后丢弃 */
function* leakRunEvent(ctx: Ctx): Flow<void> {
  // eslint-disable-next-line sgs/flow-must-be-consumed -- 故意漏写 yield*,验证运行时检测
  drawOne(ctx)
  yield* []
}

/** 漏写 yield* 的 askCard:Flow 被创建后丢弃 */
function* leakAskCard(ctx: Ctx): Flow<void> {
  // eslint-disable-next-line sgs/flow-must-be-consumed -- 故意漏写 yield*,验证运行时检测
  askJink(ctx)
  yield* []
}

/** 正确写法:两个 Flow 都 yield* 消费 */
function* consumeBoth(ctx: Ctx): Flow<void> {
  yield* drawOne(ctx)
  yield* askJink(ctx)
}

describe('detectUnconsumedFlows = true', () => {
  it.each([
    ['runEvent', leakRunEvent, 'runEvent:DrawCards'],
    ['askCard', leakAskCard, 'askCard'],
  ] as const)(
    '技能 effect 中漏写 yield* 的 %s 抛 EngineError(never consumed)',
    (_n, body, label) => {
      const game = gameWith(body, true)
      let caught: unknown = null
      try {
        game.start()
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(EngineError)
      expect((caught as EngineError).message).toContain('never consumed')
      expect((caught as EngineError).message).toContain(label)
    },
  )

  it('正确 yield* 的同类代码不误报:摸牌生效、闪的询问照常发出,回合推进到出牌阶段', () => {
    const game = gameWith(consumeBoth, true)
    game.start()
    const ask = expectRequest(game, 'askCard')
    expect(ask.player).toBe(1)
    expect(game.state.players[0]?.hand).toHaveLength(1)
    game.step(defaultResponse(ask))
    expect(expectRequest(game, 'play').player).toBe(0)
    // 技能摸 1 + 摸牌阶段 2
    expect(game.state.players[0]?.hand).toHaveLength(3)
  })
})

describe('detectUnconsumedFlows = false', () => {
  it.each([
    ['runEvent', leakRunEvent],
    ['askCard', leakAskCard],
  ] as const)('漏写 yield* 的 %s 不抛,被丢弃的 Flow 静默不执行', (_n, body) => {
    const game = gameWith(body, false)
    expect(() => game.start()).not.toThrow()
    expect(expectRequest(game, 'play').player).toBe(0)
    // 只有摸牌阶段的 2 张:技能里的摸牌 / 询问都没有发生
    expect(game.state.players[0]?.hand).toHaveLength(2)
  })
})

describe('createFlowGuard', () => {
  it('启用时:登记未注销即 check 抛错;注销后通过;禁用时恒不抛', () => {
    const on = createFlowGuard(true)
    const token = on.create('probe')
    expect(() => on.check('测试')).toThrow(/never consumed.*probe/)
    on.consume(token)
    expect(() => on.check('测试')).not.toThrow()

    const off = createFlowGuard(false)
    off.create('probe')
    expect(() => off.check('测试')).not.toThrow()
  })
})

describe('finally 内 yield 的 lint 规则', () => {
  const SELECTOR = 'TryStatement > BlockStatement.finalizer YieldExpression'
  const configPath = fileURLToPath(new URL('../../../eslint.config.js', import.meta.url))

  it('eslint.config.js 的 no-restricted-syntax 含 finally 内 yield 选择器,且作用于引擎核心目录', () => {
    const text = readFileSync(configPath, 'utf8')
    const ruleAt = text.indexOf("'no-restricted-syntax'")
    expect(ruleAt).toBeGreaterThanOrEqual(0)
    expect(text.indexOf(SELECTOR, ruleAt)).toBeGreaterThan(ruleAt)
    for (const dir of ['core', 'events', 'cards']) {
      expect(text).toContain(`'packages/engine/src/${dir}/**/*.ts'`)
    }
  })

  it('该选择器命中 finally 内的 yield,不命中 try 体内的 yield', () => {
    const linter = new Linter({ configType: 'flat' })
    const config: Linter.Config[] = [
      { rules: { 'no-restricted-syntax': ['error', { selector: SELECTOR }] } },
    ]
    const bad = 'function* f() { try { yield 1 } finally { yield 2 } }'
    const good = 'function* f() { try { yield 1 } finally { void 0 } }'
    const badMessages = linter.verify(bad, config)
    expect(badMessages).toHaveLength(1)
    expect(badMessages[0]?.ruleId).toBe('no-restricted-syntax')
    expect(linter.verify(good, config)).toStrictEqual([])
  })
})
