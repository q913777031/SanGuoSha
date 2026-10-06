/**
 * regressions.test.ts ─ M1 评审发现的回归测试(ENGINE_DESIGN.md §16.2),每个 describe 对应一条发现。
 * M1 内容走不到这些路径,因此用假牌 / 假技能复现 M2 / M3 的写法(国色、武圣、额外回合、自定义时机)。
 * 发现 5 另有编译期回归:本文件用 declare module 合并了自定义时机,pnpm typecheck 即验证核心对增广免疫。
 */
import { describe, expect, it } from 'vitest'

import type {
  CardDef,
  ContentPackage,
  Ctx,
  Flow,
  Game,
  PhaseEvent,
  PlayerId,
  PlayerState,
  StepResult,
  Suit,
  Timing,
  TriggerSkill,
  ViewAsSkill,
} from '../src/index.js'
import {
  EngineError,
  InvalidResponseError,
  STANDARD_DECK,
  TIMINGS,
  askCard,
  byName,
  defaultResponse,
  moveCards,
  runEvent,
  stage,
} from '../src/index.js'
import { answer, buildGame, createTestRegistry, expectRequest } from '../src/testing/index.js'

declare module '../src/index.js' {
  interface TimingEventMap {
    /** 测试用自定义时机:按 §10.4 由内容包合并声明,并在 ContentPackage.timings 登记 */
    'Regression.custom': PhaseEvent
  }
}

/** 牌表中第 nth 张(0 起)符合牌名 / 花色 / 点数的牌 id */
function idOf(name: string, suit: Suit, rank: number, nth = 0): number {
  const ids = STANDARD_DECK.flatMap((e, id) =>
    e.name === name && e.suit === suit && e.rank === rank ? [id] : [],
  )
  const id = ids[nth]
  if (id === undefined) throw new EngineError(`牌表中没有第 ${nth + 1} 张 ${name} ${suit}${rank}`)
  return id
}
const DIAMOND_SLASH = idOf('slash', 'diamond', 6)
const HEART_JINK = idOf('jink', 'heart', 2)
const HEART_JINK_2 = idOf('jink', 'heart', 2, 1)
const KYLIN_BOW = idOf('kylin_bow', 'heart', 5)

/** 测试用锁定触发技 */
function locked<T extends Timing>(
  id: string,
  timing: T,
  canTrigger: TriggerSkill<T>['canTrigger'],
  effect: TriggerSkill<T>['effect'],
): TriggerSkill<T> {
  return {
    id,
    name: id,
    description: id,
    type: 'trigger',
    timings: [timing],
    priority: 0,
    locked: true,
    lord: false,
    triggerWhenDead: false,
    canTrigger,
    effect,
  }
}

/** 测试用转化技:把一张 suits 花色的牌当 produces 中的牌使用 / 打出;zones 缺省则只用手牌 */
function convert(
  id: string,
  produces: string[],
  suits: Suit[],
  zones?: Array<'hand' | 'equip'>,
): ViewAsSkill {
  return {
    id,
    name: id,
    description: id,
    type: 'viewAs',
    locked: false,
    lord: false,
    produces,
    cardCount: [1, 1],
    ...(zones === undefined ? {} : { zones }),
    enabledAtPlay: () => true,
    enabledAtResponse: () => true,
    cardFilter: (ctx, _owner, card) => suits.includes(ctx.registry.spec(card).suit),
    viewAs: (ctx, _owner, cards, as) => {
      const [card] = cards
      if (card === undefined) return null
      const spec = ctx.registry.spec(card)
      return { name: as, suit: spec.suit, number: spec.number, subcards: [card], viewAs: id }
    },
  }
}

/** 只含技能 / 牌的测试内容包 */
function pkg(
  name: string,
  skills: ContentPackage['skills'],
  cards: CardDef[] = [],
): ContentPackage {
  return { name, version: '0.0.0', skills: skills ?? [], cards }
}

function playerAt(ctx: Ctx, id: PlayerId): PlayerState {
  const p = ctx.state.players[id]
  if (p === undefined) throw new EngineError(`玩家 ${id} 不存在`)
  return p
}

/** 推进到下一个 play 请求(途中请求一律默认应答),返回其玩家;对局结束返回 null */
function toNextPlay(game: Game, r: StepResult): PlayerId | null {
  let cur = r
  while (cur.type === 'request' && cur.request.kind !== 'play') {
    cur = game.step(defaultResponse(cur.request))
  }
  return cur.type === 'request' ? cur.request.player : null
}

/** 结束当前出牌阶段并推进到下一个 play 请求 */
function endPlay(game: Game): PlayerId | null {
  return toNextPlay(game, answer(game, { action: 'end' }))
}

function* loseAllHp(ctx: Ctx, _ev: unknown, owner: PlayerId): Flow<void> {
  yield* runEvent(ctx, { kind: 'LoseHp', player: owner, amount: 4, reasonId: null })
}

describe('发现 1:回合玩家在阶段开始时机死亡后不执行阶段正文', () => {
  const registry = createTestRegistry(
    pkg('regression-1', [
      locked(
        'die-at-draw-start',
        'Phase.start',
        (_ctx, ev, owner) => ev.player === owner && ev.phase === 'draw',
        loseAllHp,
      ),
      locked(
        'die-before-draw',
        'DrawCards.before',
        (_ctx, ev, owner) => ev.player === owner && ev.reason === 'phase',
        loseAllHp,
      ),
    ]),
  )

  it.each(['die-at-draw-start', 'die-before-draw'])('%s:死者不摸牌,回合交给下家', (skill) => {
    const game = buildGame(registry, { players: [{ skills: [skill] }, {}, {}] })
    expect(toNextPlay(game, game.start())).toBe(1)
    expect(game.state.players[0]?.alive).toBe(false)
    expect(game.state.players[0]?.hand).toEqual([])
  })
})

describe('发现 2:额外回合结束后回到原回合玩家的下家', () => {
  const grant = locked(
    'grant-extra-turn',
    'Turn.end',
    (ctx, ev, owner) => ev.player === owner && playerAt(ctx, owner).flags['granted'] === undefined,
    function* (ctx, _ev, owner) {
      playerAt(ctx, owner).flags['granted'] = true
      ctx.state.turnQueue.push(2)
      yield* []
    },
  )
  const registry = createTestRegistry(pkg('regression-2', [grant]))

  it('P0 回合结束时给 P2 一个额外回合:0 → 2(额外)→ 1 → 2 → 3 → 0', () => {
    const game = buildGame(registry, { players: [{ skills: ['grant-extra-turn'] }, {}, {}, {}] })
    const order = [toNextPlay(game, game.start())]
    for (let i = 0; i < 5; i++) order.push(endPlay(game))
    expect(order).toEqual([0, 2, 1, 2, 3, 0])
  })
})

describe('发现 3:被跳过的阶段同样清理 @phase 标记', () => {
  const seen: string[] = []
  const registry = createTestRegistry(
    pkg('regression-3', [
      locked(
        'skip-finish',
        'Phase.before',
        (_ctx, ev, owner) => ev.player === owner && ev.phase === 'finish',
        function* (ctx, ev, owner) {
          const p = playerAt(ctx, owner)
          p.flags['x@phase'] = true
          p.marks['m@phase'] = 1
          ev.cancelled = true
          yield* []
        },
      ),
      locked(
        'probe-turn-end',
        'Turn.end',
        (_ctx, ev, owner) => ev.player === owner,
        function* (ctx, _ev, owner) {
          const p = playerAt(ctx, owner)
          seen.push(...Object.keys(p.flags), ...Object.keys(p.marks))
          yield* []
        },
      ),
    ]),
  )

  it('Phase.before 写入 @phase 标记并取消结束阶段:Turn.end 时已清除', () => {
    const game = buildGame(registry, {
      players: [{ skills: ['skip-finish', 'probe-turn-end'] }, {}],
    })
    toNextPlay(game, game.start())
    expect(endPlay(game)).toBe(1)
    expect(seen).toEqual([])
  })
})

describe('发现 4:转化的延时锦囊在判定区保留牌名', () => {
  /** 简化的乐不思蜀:使用时入目标判定区(as = 牌名);判定阶段生效即跳过出牌阶段(省去判定) */
  const indulgence: CardDef = {
    name: 'indulgence',
    type: 'delayed_trick',
    equip: null,
    judgePattern: null,
    nullifiable: false,
    target: { min: 1, max: 1, auto: null, range: null, excludeSelf: true },
    *effect(ctx, eff) {
      const [card] = eff.card.subcards
      if (eff.target === null || card === undefined) return
      if (eff.delayed) {
        ctx.state.turn?.skipPhases.push('play')
        return
      }
      yield* moveCards(ctx, [
        {
          card,
          to: { kind: 'judge', player: eff.target },
          reason: 'delayed_trick',
          as: eff.card.name,
        },
      ])
    },
  }
  const registry = createTestRegistry(
    pkg('regression-4', [convert('guose', ['indulgence'], ['diamond'])], [indulgence]),
  )

  it('国色把 ♦6 杀当乐:判定阶段按乐结算(跳过出牌、不受伤),离开判定区清除记录', () => {
    const game = buildGame(registry, {
      players: [{ skills: ['guose'], hand: [DIAMOND_SLASH] }, {}, {}],
    })
    toNextPlay(game, game.start())
    answer(game, {
      action: 'useSkill',
      skill: 'guose',
      as: 'indulgence',
      cards: [DIAMOND_SLASH],
      targets: [1],
    })
    expect(game.state.players[1]?.judgeArea).toEqual([DIAMOND_SLASH])
    expect(game.state.players[1]?.judgeAs).toEqual({ [DIAMOND_SLASH]: 'indulgence' })
    expect(game.viewFor(2).players[1]?.judgeAs).toEqual({ [DIAMOND_SLASH]: 'indulgence' })
    // P1 的出牌阶段被跳过,下一个 play 请求属于 P2
    expect(endPlay(game)).toBe(2)
    expect(game.state.players[1]?.hp).toBe(4)
    expect(game.state.players[1]?.judgeArea).toEqual([])
    expect(game.state.players[1]?.judgeAs).toEqual({})
    expect(game.state.discardPile).toContain(DIAMOND_SLASH)
  })
})

describe('发现 5:内容包按 §10.4 增加的时机可登记、可触发', () => {
  const records: string[] = []
  const custom: ContentPackage = {
    ...pkg('regression-5', [
      locked(
        'emit-custom',
        'Phase.start',
        (_ctx, ev, owner) => ev.player === owner && ev.phase === 'play',
        function* (ctx, ev) {
          yield* stage(ctx, 'Regression.custom', ev)
        },
      ),
      locked(
        'listen-custom',
        'Regression.custom',
        (_ctx, ev, owner) => ev.player === owner,
        function* (_ctx, ev) {
          records.push(`custom:${ev.phase}`)
          yield* []
        },
      ),
    ]),
    timings: ['Regression.custom'],
  }

  it('登记后建立索引并按时机触发;TIMINGS 只含内置时机', () => {
    const registry = createTestRegistry(custom)
    expect(registry.triggerSkillsAt('Regression.custom')).toHaveLength(1)
    expect(registry.triggerPriorities('Regression.custom')).toEqual([0])
    expect(TIMINGS).not.toContain('Regression.custom')
    const game = buildGame(registry, {
      players: [{ skills: ['emit-custom', 'listen-custom'] }, {}],
    })
    expect(toNextPlay(game, game.start())).toBe(0)
    expect(records).toEqual(['custom:play'])
  })

  it('未登记的自定义时机在 build() 时报错并提示 ContentPackage.timings', () => {
    expect(() => createTestRegistry({ ...custom, timings: [] })).toThrow(/ContentPackage\.timings/)
  })
})

describe('发现 6:转化技可选装备区的牌', () => {
  const askSlash = locked(
    'ask-slash',
    'Phase.start',
    (_ctx, ev, owner) => ev.player === owner && ev.phase === 'play',
    function* (ctx, ev) {
      yield* askCard(ctx, {
        player: 1,
        pattern: byName('slash'),
        mode: 'play',
        targets: [],
        againstId: null,
        reasonId: ev.id,
        prompt: { key: 'test', args: {} },
      })
    },
  )
  const registry = createTestRegistry(
    pkg('regression-6', [
      convert('wusheng', ['slash'], ['heart', 'diamond'], ['hand', 'equip']),
      convert('hand-only', ['slash'], ['heart', 'diamond']),
      askSlash,
    ]),
  )

  it('出牌阶段:候选为手牌后接装备区的牌,以装备区的牌转化的杀照常结算', () => {
    const game = buildGame(registry, {
      players: [
        { skills: ['wusheng', 'hand-only'], hand: [HEART_JINK], equips: { weapon: KYLIN_BOW } },
        {},
      ],
      // 摸牌阶段摸到两张黑色牌,不进入候选
      drawPileTop: [idOf('dismantlement', 'spade', 3), idOf('dismantlement', 'spade', 4)],
    })
    toNextPlay(game, game.start())
    const req = expectRequest(game, 'play')
    const candidates = (skill: string): number[] | undefined =>
      req.usableSkills.find((u) => u.skill === skill)?.cards.candidates
    expect(candidates('wusheng')).toEqual([HEART_JINK, KYLIN_BOW])
    expect(candidates('hand-only')).toEqual([HEART_JINK])
    answer(game, {
      action: 'useSkill',
      skill: 'wusheng',
      as: 'slash',
      cards: [KYLIN_BOW],
      targets: [1],
    })
    expect(game.state.players[0]?.equips.weapon).toBeNull()
    expect(game.state.players[1]?.hp).toBe(3)
    expect(game.state.discardPile).toContain(KYLIN_BOW)
  })

  it('响应询问:viewAsSkills 的候选同样含装备区的牌,可用它打出', () => {
    const game = buildGame(registry, {
      players: [{ skills: ['ask-slash'] }, { skills: ['wusheng'], equips: { weapon: KYLIN_BOW } }],
    })
    game.start()
    const req = expectRequest(game, 'askCard')
    expect(req.player).toBe(1)
    expect(req.viewAsSkills).toEqual([
      { skill: 'wusheng', cards: { candidates: [KYLIN_BOW], min: 1, max: 1 } },
    ])
    answer(game, { card: null, viewAs: { skill: 'wusheng', cards: [KYLIN_BOW] }, targets: [] })
    expect(game.state.players[1]?.equips.weapon).toBeNull()
    expect(game.state.discardPile).toContain(KYLIN_BOW)
  })
})

describe('发现 7:出牌阶段的转化牌同样受 CardDef.canUse 约束', () => {
  const registry = createTestRegistry(
    pkg('regression-7', [convert('red-as-any', ['slash', 'jink'], ['heart', 'diamond'])]),
  )

  it('不提供只能响应的闪;出过一次杀后不再提供转化杀,强行发动被拒', () => {
    const game = buildGame(registry, {
      players: [{ skills: ['red-as-any'], hand: [HEART_JINK, HEART_JINK_2] }, {}],
    })
    toNextPlay(game, game.start())
    const offered = (): Array<string | null> =>
      expectRequest(game, 'play').usableSkills.map((u) => u.as)
    expect(offered()).toEqual(['slash'])
    answer(game, {
      action: 'useSkill',
      skill: 'red-as-any',
      as: 'slash',
      cards: [HEART_JINK],
      targets: [1],
    })
    expect(game.state.players[1]?.hp).toBe(3)
    expect(offered()).toEqual([])
    expect(() =>
      answer(game, {
        action: 'useSkill',
        skill: 'red-as-any',
        as: 'slash',
        cards: [HEART_JINK_2],
        targets: [1],
      }),
    ).toThrow(InvalidResponseError)
  })
})
