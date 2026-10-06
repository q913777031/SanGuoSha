/**
 * basic-cards.test.ts ─ M1 基本牌杀 / 闪 / 桃的结算(设计 §10.2 / §12a / §3.2)。
 * 全部 Game.fromState(buildState(...)) + 同步 step 脚本,固定种子;
 * 以测试内容包注入锁定技观察 CardEffect 结果、改伤害量、对已死亡者造成伤害、取消使用。
 */
import { describe, expect, it } from 'vitest'

import type {
  CardId,
  CardName,
  DamageEvent,
  Registry,
  SkillDef,
  StepResult,
  Timing,
  TimingEventMap,
  TriggerSkill,
} from '../src/index.js'
import { EngineError, Game, InvalidResponseError, runEvent } from '../src/index.js'
import type { ResponseBody, StateSpec } from '../src/testing/index.js'
import {
  TEST_OPTIONS,
  answer,
  buildState,
  createTestRegistry,
  expectRequest,
} from '../src/testing/index.js'

/** CardEffect.after 时记录的效果摘要 */
interface EffectRecord {
  card: CardName
  target: number | null
  responded: boolean
}

/** 测试夹具:注册表 + 测试技能写入的记录 */
interface Fixture {
  registry: Registry
  effects: EffectRecord[]
  deadDamage: DamageEvent[]
}

/** 锁定技:无需询问,拥有者死亡后也触发 */
function lockedSkill<T extends Timing>(
  id: string,
  timing: T,
  canTrigger: (ev: TimingEventMap[T], owner: number) => boolean,
  effect: TriggerSkill<T>['effect'],
): TriggerSkill<T> {
  return {
    id,
    name: id,
    description: `测试技能 ${id}`,
    type: 'trigger',
    timings: [timing],
    priority: 0,
    locked: true,
    lord: false,
    triggerWhenDead: true,
    canTrigger: (_ctx, ev, owner) => canTrigger(ev, owner),
    effect,
  }
}

/**
 * 测试注册表:
 * test:effects 记录每个 CardEffect.after;test:double 拥有者造成的伤害改为 2;
 * test:hitDead 拥有者出牌阶段开始时对 2 号位造成 1 点伤害;test:cancelUse 取消拥有者的 CardUse。
 */
function fixture(): Fixture {
  const effects: EffectRecord[] = []
  const deadDamage: DamageEvent[] = []
  const skills: SkillDef[] = [
    lockedSkill(
      'test:effects',
      'CardEffect.after',
      () => true,
      function* (_ctx, ev) {
        effects.push({ card: ev.card.name, target: ev.target, responded: ev.responded })
        yield* []
      },
    ),
    lockedSkill(
      'test:double',
      'Damage.caused',
      (ev, owner) => ev.from === owner,
      function* (_ctx, ev) {
        ev.amount = 2
        yield* []
      },
    ),
    lockedSkill(
      'test:hitDead',
      'Phase.start',
      (ev, owner) => ev.player === owner && ev.phase === 'play',
      function* (ctx, _ev, owner) {
        const dmg = yield* runEvent(ctx, {
          kind: 'Damage',
          from: owner,
          to: 2,
          amount: 1,
          nature: 'normal',
          card: null,
          causeId: null,
        })
        deadDamage.push(dmg)
      },
    ),
    lockedSkill(
      'test:cancelUse',
      'CardUse.before',
      (ev, owner) => ev.source === owner,
      function* (_ctx, ev) {
        ev.cancelled = true
        yield* []
      },
    ),
  ]
  const registry = createTestRegistry({ name: 'test-basic', version: '0.0.0', skills })
  return { registry, effects, deadDamage }
}

/** 牌表中第 nth 张名为 name 的牌 id */
function card(registry: Registry, name: CardName, nth = 0): CardId {
  const id = registry.deck.filter((c) => c.name === name)[nth]?.id
  if (id === undefined) throw new EngineError(`牌表中没有第 ${nth} 张 ${name}`)
  return id
}

/** Game.fromState(buildState(...)) 并 start;0 号位的回合从准备阶段直接走到出牌阶段 */
function startGame(registry: Registry, spec: StateSpec): { game: Game; first: StepResult } {
  const full: StateSpec = { seed: 7, ...spec }
  const state = buildState(registry, full)
  const game = Game.fromState(state, registry, {
    seed: 7,
    mode: 'ffa',
    players: full.players.map(() => ({ general: null })),
    fixedDeckOrder: null,
    options: TEST_OPTIONS,
  })
  return { game, first: game.start() }
}

/** 牌 id 升序副本:响应牌先于杀离开处理区,弃牌堆顺序不是断言重点 */
const sorted = (cards: readonly CardId[]): CardId[] => [...cards].sort((x, y) => x - y)

/** 不响应的 askCard 应答正文 */
const NO_CARD: ResponseBody = { card: null, viewAs: null, targets: [] }

describe('杀与闪', () => {
  it('杀 → 目标出闪:无伤害,CardEffect.responded = true,杀与闪进弃牌堆,turn.history 记录两次使用', () => {
    const { registry, effects } = fixture()
    const slash = card(registry, 'slash')
    const jink = card(registry, 'jink')
    const { game } = startGame(registry, {
      players: [{ hand: [slash], skills: ['test:effects'] }, { hand: [jink] }, {}],
    })
    expectRequest(game, 'play')
    answer(game, { action: 'useCard', card: slash, targets: [1] })
    const ask = expectRequest(game, 'askCard')
    expect(ask.player).toBe(1)
    expect(ask.candidates).toEqual([jink])
    answer(game, { card: jink, viewAs: null, targets: [] })

    expect(expectRequest(game, 'play').player).toBe(0)
    expect(game.state.players[1]?.hp).toBe(4)
    expect(effects.find((e) => e.card === 'slash')).toEqual({
      card: 'slash',
      target: 1,
      responded: true,
    })
    expect(game.log.some((l) => l.type === 'damage')).toBe(false)
    expect(sorted(game.state.discardPile)).toEqual(sorted([slash, jink]))
    expect(game.state.processing).toEqual([])
    expect(game.state.turn?.history).toEqual([
      { player: 0, card: 'slash', mode: 'use', reason: 'play', phase: 'play' },
      { player: 1, card: 'jink', mode: 'use', reason: 'response', phase: 'play' },
    ])
  })

  it('杀 → 目标不出闪:受到 1 点伤害,responded = false', () => {
    const { registry, effects } = fixture()
    const slash = card(registry, 'slash')
    const jink = card(registry, 'jink')
    const { game } = startGame(registry, {
      players: [{ hand: [slash], skills: ['test:effects'] }, { hand: [jink] }, {}],
    })
    answer(game, { action: 'useCard', card: slash, targets: [1] })
    expectRequest(game, 'askCard')
    answer(game, NO_CARD)

    expectRequest(game, 'play')
    expect(game.state.players[1]?.hp).toBe(3)
    expect(game.state.players[1]?.hand).toEqual([jink])
    expect(effects).toEqual([{ card: 'slash', target: 1, responded: false }])
    expect(game.state.discardPile).toEqual([slash])
  })

  it('杀的目标必须在攻击范围内且不能是自己', () => {
    const { registry } = fixture()
    const slash = card(registry, 'slash')
    const { game } = startGame(registry, { players: [{ hand: [slash] }, {}, {}, {}] })
    const play = expectRequest(game, 'play')
    expect(play.usableCards).toEqual([
      { card: slash, targets: { candidates: [1, 3], min: 1, max: 1 } },
    ])
    expect(() => answer(game, { action: 'useCard', card: slash, targets: [2] })).toThrow(
      InvalidResponseError,
    )
    expect(() => answer(game, { action: 'useCard', card: slash, targets: [0] })).toThrow(
      InvalidResponseError,
    )
    // throw 策略不前进:同一请求仍可应答
    answer(game, { action: 'useCard', card: slash, targets: [3] })
    expect(game.state.players[3]?.hp).toBe(3)
  })

  it('出牌阶段杀限一次:第二张杀不在 usableCards 中且使用被拒', () => {
    const { registry } = fixture()
    const s1 = card(registry, 'slash', 0)
    const s2 = card(registry, 'slash', 1)
    const { game } = startGame(registry, { players: [{ hand: [s1, s2] }, {}] })
    expect(expectRequest(game, 'play').usableCards.map((u) => u.card)).toEqual([s1, s2])
    answer(game, { action: 'useCard', card: s1, targets: [1] })
    expect(expectRequest(game, 'play').usableCards).toEqual([])
    expect(() => answer(game, { action: 'useCard', card: s2, targets: [1] })).toThrow(
      InvalidResponseError,
    )
  })

  it('闪不能主动使用', () => {
    const { registry } = fixture()
    const jink = card(registry, 'jink')
    const { game } = startGame(registry, { players: [{ hand: [jink] }, {}] })
    expect(expectRequest(game, 'play').usableCards).toEqual([])
    expect(() => answer(game, { action: 'useCard', card: jink, targets: [] })).toThrow(
      InvalidResponseError,
    )
  })
})

describe('桃', () => {
  it('只在体力未满时于出牌阶段对自己使用,回复 1 点', () => {
    const { registry } = fixture()
    const peach = card(registry, 'peach')
    const full = startGame(registry, { players: [{ hand: [peach] }, {}] }).game
    expect(expectRequest(full, 'play').usableCards).toEqual([])
    expect(() => answer(full, { action: 'useCard', card: peach, targets: [] })).toThrow(
      InvalidResponseError,
    )

    const { game } = startGame(registry, { players: [{ hand: [peach], hp: 3 }, {}] })
    expect(expectRequest(game, 'play').usableCards).toEqual([
      { card: peach, targets: { candidates: [], min: 0, max: 0 } },
    ])
    answer(game, { action: 'useCard', card: peach, targets: [] })
    expect(game.state.players[0]?.hp).toBe(4)
    expect(game.state.discardPile).toEqual([peach])
    expect(expectRequest(game, 'play').usableCards).toEqual([])
  })
})

describe('濒死求桃与死亡', () => {
  it('杀 → 伤害 → 濒死:从当前回合玩家起依次问桃,被救回后不再询问', () => {
    const { registry } = fixture()
    const slash = card(registry, 'slash')
    const [p0, p1, p2] = [0, 1, 2].map((n) => card(registry, 'peach', n)) as [
      CardId,
      CardId,
      CardId,
    ]
    const { game } = startGame(registry, {
      players: [{ hand: [slash, p0] }, { hand: [p1], hp: 1 }, { hand: [p2] }, {}],
    })
    answer(game, { action: 'useCard', card: slash, targets: [1] })
    const asked: number[] = []
    for (const decline of [true, true, false]) {
      const req = expectRequest(game, 'askCard')
      expect(req.pattern).toMatchObject({ names: ['peach'] })
      expect(req.fixedTargets).toEqual([1])
      asked.push(req.player)
      answer(game, decline ? NO_CARD : { card: p2, viewAs: null, targets: [] })
    }
    expect(asked).toEqual([0, 1, 2])
    expect(expectRequest(game, 'play').player).toBe(0)
    expect(game.state.players[1]).toMatchObject({ hp: 1, alive: true })
    expect(sorted(game.state.discardPile)).toEqual(sorted([slash, p2]))
    expect(game.state.turn?.history.map((h) => [h.player, h.card, h.reason])).toEqual([
      [0, 'slash', 'play'],
      [2, 'peach', 'response'],
    ])
  })

  it('同一人可连续出两张桃;hp > 0 后停止询问', () => {
    const { registry } = fixture()
    const slash = card(registry, 'slash')
    const [a, b, c] = [0, 1, 2].map((n) => card(registry, 'peach', n)) as [CardId, CardId, CardId]
    const { game } = startGame(registry, {
      players: [{ hand: [slash], skills: ['test:double'] }, { hand: [a, b], hp: 1 }, { hand: [c] }],
    })
    answer(game, { action: 'useCard', card: slash, targets: [1] })
    expect(game.state.players[1]?.hp).toBe(-1)
    const asked: number[] = []
    for (const peach of [a, b]) {
      asked.push(expectRequest(game, 'askCard').player)
      answer(game, { card: peach, viewAs: null, targets: [] })
    }
    expect(asked).toEqual([1, 1])
    expect(expectRequest(game, 'play').player).toBe(0)
    expect(game.state.players[1]).toMatchObject({ hp: 1, alive: true, hand: [] })
    expect(game.state.players[2]?.hand).toEqual([c])
  })

  it('无人出桃 → 死亡:遗留牌进弃牌堆,对局继续', () => {
    const { registry } = fixture()
    const slash = card(registry, 'slash')
    const jink = card(registry, 'jink')
    const { game } = startGame(registry, {
      players: [{ hand: [slash] }, { hand: [jink], hp: 1 }, {}],
    })
    answer(game, { action: 'useCard', card: slash, targets: [1] })
    answer(game, NO_CARD)
    expect(expectRequest(game, 'play').player).toBe(0)
    expect(game.state.players[1]).toMatchObject({ hp: 0, alive: false, hand: [] })
    expect(sorted(game.state.discardPile)).toEqual(sorted([slash, jink]))
    expect(game.log.find((l) => l.type === 'death')?.data).toEqual({
      player: 1,
      role: 'none',
      killer: 0,
    })
  })

  it('无人出桃 → 死亡 → FFA 只剩一人:GameOver', () => {
    const { registry } = fixture()
    const slash = card(registry, 'slash')
    const { game } = startGame(registry, { players: [{ hand: [slash] }, { hp: 1 }] })
    const r = answer(game, { action: 'useCard', card: slash, targets: [1] })
    expect(r).toMatchObject({ type: 'over', result: { winners: [0], reason: 'lastSurvivor' } })
    expect(game.state.phase).toBe('over')
    expect(game.state.result).toEqual({ winners: [0], reason: 'lastSurvivor' })
    expect(game.pending).toBeNull()
  })

  it('对已死亡者造成伤害被取消:不扣血、不濒死、无伤害日志', () => {
    const { registry, deadDamage } = fixture()
    const { game } = startGame(registry, {
      players: [{ skills: ['test:hitDead'] }, {}, { hp: 0, alive: false }],
    })
    expectRequest(game, 'play')
    expect(deadDamage).toHaveLength(1)
    expect(deadDamage[0]?.cancelled).toBe(true)
    expect(game.state.players[2]?.hp).toBe(0)
    expect(game.log.some((l) => l.type === 'damage' || l.type === 'dying')).toBe(false)
  })
})

describe('残留牌', () => {
  it('CardUse.before 被取消:不产生效果,牌仍从处理区进弃牌堆', () => {
    const { registry, effects } = fixture()
    const slash = card(registry, 'slash')
    const { game } = startGame(registry, {
      players: [{ hand: [slash], skills: ['test:cancelUse', 'test:effects'] }, {}],
    })
    answer(game, { action: 'useCard', card: slash, targets: [1] })
    expectRequest(game, 'play')
    expect(effects).toEqual([])
    expect(game.state.players[1]?.hp).toBe(4)
    expect(game.state.processing).toEqual([])
    expect(game.state.discardPile).toEqual([slash])
  })
})
