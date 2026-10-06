/**
 * modifiers.test.ts ─ 修正技折叠与派生查询(设计 §7 / D7 / §12e)。
 * 用 createTestRegistry 注入假修正技、假武将与假装备(武器 / 坐骑的 CardDef),验证:
 *  fold 折叠顺序 = 座位 0 起(与回合无关)+ 同玩家 skillsOf 顺序(武将声明序 → 后天技能 → 装备槽序);
 *  attackRange 基值(无武器 1、有武器取 equip.range)与钩子修正;
 *  distance = max(1, 存活环上最短座位距离 + 进攻马(−1)+ 防御马(+1))与 distanceFrom / distanceTo 钩子;
 *  useLimit(杀 1、其余 UNLIMITED、钩子可改为 UNLIMITED)与 usedInPlay 只统计 reason === 'play' 的使用;
 *  maxHandCards = hp 与弃牌阶段的衔接;prohibitTarget / ignoreDistance / extraTargets 对 legalTargets 的影响。
 * 全部同步脚本式(Game.start / step),固定种子。
 */
import { describe, expect, it } from 'vitest'

import type {
  CardDef,
  CardFace,
  CardId,
  CardName,
  ContentPackage,
  Ctx,
  EquipSlot,
  Game,
  GeneralDef,
  ModifierHooks,
  ModifierSkill,
  PlayerId,
  Registry,
  SkillDef,
  SkillId,
} from '../src/index.js'
import {
  EngineError,
  UNLIMITED,
  attackRange,
  createFlowGuard,
  distance,
  faceOf,
  fold,
  handlers,
  inAttackRange,
  legalTargets,
  maxHandCards,
  seatDistance,
  useLimit,
  usedInPlay,
  weaponRange,
} from '../src/index.js'
import { answer, buildGame, createTestRegistry, expectRequest } from '../src/testing/index.js'

/** 构造一个假修正技(锁定技、非主公技) */
function modifierSkill(id: SkillId, modifiers: Partial<ModifierHooks>): ModifierSkill {
  return {
    id,
    name: id,
    description: `测试修正技 ${id}`,
    type: 'modifier',
    locked: true,
    lord: false,
    modifiers,
  }
}

/** 假武将:4 血、魏、男,技能按给定顺序声明 */
function defineGeneral(id: string, skills: SkillId[]): GeneralDef {
  return { id, name: id, kingdom: 'wei', gender: 'male', maxHp: 4, skills }
}

/** 装备牌的 CardDef(名字与标准牌堆一致,不能主动使用;只提供 range / distance 基值与 equip.skills) */
function equipCard(
  name: CardName,
  slot: EquipSlot,
  spec: { range?: number; distance?: number; skills?: SkillId[] } = {},
): CardDef {
  return {
    name,
    type: 'equip',
    equip: {
      slot,
      range: spec.range ?? null,
      distance: spec.distance ?? null,
      skills: spec.skills ?? [],
    },
    judgePattern: null,
    nullifiable: false,
    target: { min: 0, max: 0, auto: 'self', range: null, excludeSelf: false },
    canUse: () => false,
  }
}

/** 测试内容包 */
function packageOf(
  skills: SkillDef[],
  generals: GeneralDef[],
  cards: CardDef[] = [],
): ContentPackage {
  return { name: 'test-modifiers', version: '0.0.0', skills, generals, cards }
}

/** 牌表中第 nth 张名为 name 的牌 id */
function cardNamed(registry: Registry, name: CardName, nth = 0): CardId {
  const ids = registry.deck.filter((c) => c.name === name).map((c) => c.id)
  const id = ids[nth]
  if (id === undefined) throw new EngineError(`牌表中没有第 ${nth} 张 ${name}`)
  return id
}

/** 牌表中前 count 张名为 name 的牌 id */
function cardsNamed(registry: Registry, name: CardName, count: number): CardId[] {
  const ids: CardId[] = []
  for (let i = 0; i < count; i++) ids.push(cardNamed(registry, name, i))
  return ids
}

/** 只读查询用的 Ctx(fold / distance 等只读 state 与 registry;其余成员为不可用的占位实现) */
function ctxOf(game: Game): Ctx {
  const unavailable = (): never => {
    throw new EngineError('测试 Ctx 不提供随机源')
  }
  return {
    state: game.state,
    registry: game.registry,
    config: game.config,
    options: game.options,
    handlers,
    guard: createFlowGuard(false),
    log: () => undefined,
    random: unavailable,
    randomInt: unavailable,
    shuffle: unavailable,
    onTurnBoundary: () => undefined,
  }
}

/** 标准牌堆里的杀 / 桃 / 闪的 CardFace(按牌表第一张) */
function faceNamed(ctx: Ctx, name: CardName): CardFace {
  return faceOf(ctx, cardNamed(ctx.registry, name))
}

/** 常用的假装备:青龙偃月刀(射程 3)、麒麟弓(射程 5)、诸葛连弩(射程 1 + 连弩技)、赤兔(−1)、的卢(+1)、八卦阵(无技能) */
const crossbowSkill = modifierSkill('equip.crossbow', {
  useLimit: (_ctx, owner, v, subject, card) =>
    subject === owner && card.name === 'slash' ? UNLIMITED : v,
})
const STANDARD_EQUIPS: CardDef[] = [
  equipCard('blade', 'weapon', { range: 3 }),
  equipCard('kylin_bow', 'weapon', { range: 5 }),
  equipCard('crossbow', 'weapon', { range: 1, skills: ['equip.crossbow'] }),
  equipCard('chitu', 'horse_offensive', { distance: -1 }),
  equipCard('dilu', 'horse_defensive', { distance: 1 }),
  equipCard('eight_diagram', 'armor'),
]

describe('fold 折叠顺序', () => {
  it('座位 0 起(与当前回合玩家无关),同玩家按 skillsOf 顺序:武将声明序 → 后天技能 → 装备按槽序;非修正技与缺该钩子的修正技被跳过', () => {
    const records: string[] = []
    const rec = (id: SkillId): ModifierSkill =>
      modifierSkill(id, {
        attackRange: (_ctx, owner, v) => {
          records.push(`${owner}:${id}`)
          return v + 1
        },
      })
    // other 只提供别的钩子;trig 是触发技:二者都不应出现在 attackRange 折叠里
    const other = modifierSkill('other', { maxHandCards: (_ctx, _owner, v) => v })
    const trig: SkillDef = {
      id: 'trig',
      name: 'trig',
      description: '测试触发技',
      type: 'trigger',
      timings: ['Turn.start'],
      priority: 0,
      locked: true,
      lord: false,
      triggerWhenDead: false,
      canTrigger: () => false,
      *effect() {},
    }
    const registry = createTestRegistry(
      packageOf(
        [
          rec('m1'),
          rec('m2'),
          rec('m3'),
          rec('mw'),
          rec('ma'),
          rec('mho'),
          rec('mhd'),
          rec('n1'),
          other,
          trig,
        ],
        [defineGeneral('gA', ['m1', 'other', 'm2']), defineGeneral('gB', ['trig', 'n1'])],
        [
          equipCard('blade', 'weapon', { range: 2, skills: ['mw'] }),
          equipCard('eight_diagram', 'armor', { skills: ['ma'] }),
          equipCard('chitu', 'horse_offensive', { distance: -1, skills: ['mho'] }),
          equipCard('dilu', 'horse_defensive', { distance: 1, skills: ['mhd'] }),
        ],
      ),
    )
    // lastTurnPlayer = 1 ⇒ 本回合玩家是 2 号位;折叠仍从 0 号位起
    const game = buildGame(registry, {
      players: [
        {
          general: 'gA',
          skills: ['m1', 'other', 'm2', 'm3'],
          equips: {
            weapon: cardNamed(registry, 'blade'),
            armor: cardNamed(registry, 'eight_diagram'),
            horse_offensive: cardNamed(registry, 'chitu'),
            horse_defensive: cardNamed(registry, 'dilu'),
          },
        },
        { general: 'gB' },
        { general: 'placeholder' },
      ],
      lastTurnPlayer: 1,
      drawPileTop: cardsNamed(registry, 'jink', 2),
    })
    game.start()
    expect(expectRequest(game, 'play').player).toBe(2)
    const ctx = ctxOf(game)
    records.length = 0
    expect(fold(ctx, 'attackRange', 10, 2)).toBe(18)
    expect(records).toStrictEqual([
      '0:m1',
      '0:m2',
      '0:m3',
      '0:mw',
      '0:ma',
      '0:mho',
      '0:mhd',
      '1:n1',
    ])
    // 武器基值 2 经同样的 8 个钩子折叠
    records.length = 0
    expect(attackRange(ctx, 0)).toBe(10)
    expect(records).toHaveLength(8)
  })

  it('钩子依次作用于前一个钩子的返回值:0 号位 ×2 先于 1 号位 +1', () => {
    const registry = createTestRegistry(
      packageOf(
        [
          modifierSkill('double', { maxHandCards: (_ctx, _owner, v) => v * 2 }),
          modifierSkill('plusOne', { maxHandCards: (_ctx, _owner, v) => v + 1 }),
        ],
        [defineGeneral('gDouble', ['double']), defineGeneral('gPlus', ['plusOne'])],
      ),
    )
    const ctx = ctxOf(
      buildGame(registry, { players: [{ general: 'gDouble' }, { general: 'gPlus' }] }),
    )
    expect(fold(ctx, 'maxHandCards', 3, 0)).toBe(7)
    // 座位互换后顺序相反:(3 + 1) × 2
    const swapped = ctxOf(
      buildGame(registry, { players: [{ general: 'gPlus' }, { general: 'gDouble' }] }),
    )
    expect(fold(swapped, 'maxHandCards', 3, 0)).toBe(8)
  })

  it('无任何修正技时返回基值;钩子收到的 owner 是技能拥有者、args 原样透传', () => {
    const seen: Array<[PlayerId, PlayerId, PlayerId]> = []
    const registry = createTestRegistry(
      packageOf(
        [
          modifierSkill('spy', {
            distanceFrom: (_ctx, owner, v, from, to) => {
              seen.push([owner, from, to])
              return v
            },
          }),
        ],
        [defineGeneral('gSpy', ['spy'])],
      ),
    )
    const plain = ctxOf(
      buildGame(registry, { players: [{ general: 'placeholder' }, { general: 'placeholder' }] }),
    )
    expect(fold(plain, 'attackRange', 1, 0)).toBe(1)
    expect(fold(plain, 'prohibitTarget', false, 0, 1, faceNamed(plain, 'slash'))).toBe(false)
    const ctx = ctxOf(
      buildGame(registry, { players: [{ general: 'placeholder' }, { general: 'gSpy' }] }),
    )
    expect(fold(ctx, 'distanceFrom', 0, 0, 1)).toBe(0)
    expect(seen).toStrictEqual([[1, 0, 1]])
  })

  it('主公技修正技在无身份模式(lordSkillsEnabled 为假)下不参与折叠', () => {
    const lordSkill: ModifierSkill = {
      ...modifierSkill('lordOnly', { attackRange: (_ctx, _owner, v) => v + 100 }),
      lord: true,
    }
    const registry = createTestRegistry(
      packageOf([lordSkill], [defineGeneral('gLord', ['lordOnly'])]),
    )
    const ctx = ctxOf(
      buildGame(registry, { players: [{ general: 'gLord' }, { general: 'placeholder' }] }),
    )
    expect(attackRange(ctx, 0)).toBe(1)
  })
})

describe('attackRange 攻击范围', () => {
  const registry = createTestRegistry(
    packageOf(
      [
        crossbowSkill,
        modifierSkill('longArm', {
          attackRange: (_ctx, owner, v, subject) => (subject === owner ? v + 1 : v),
        }),
      ],
      [defineGeneral('gLong', ['longArm'])],
      STANDARD_EQUIPS,
    ),
  )

  it('无武器时基值为 1', () => {
    const ctx = ctxOf(
      buildGame(registry, { players: [{ general: 'placeholder' }, { general: 'placeholder' }] }),
    )
    expect(weaponRange(ctx, 0)).toBe(1)
    expect(attackRange(ctx, 0)).toBe(1)
  })

  it('有武器时基值取 CardDef.equip.range(青龙偃月刀 3、麒麟弓 5、连弩 1)', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'placeholder', equips: { weapon: cardNamed(registry, 'blade') } },
          { general: 'placeholder', equips: { weapon: cardNamed(registry, 'kylin_bow') } },
          { general: 'placeholder', equips: { weapon: cardNamed(registry, 'crossbow') } },
        ],
      }),
    )
    expect(attackRange(ctx, 0)).toBe(3)
    expect(attackRange(ctx, 1)).toBe(5)
    expect(attackRange(ctx, 2)).toBe(1)
  })

  it('未注册的武器(M1 牌堆里的丈八蛇矛)视为基值 1', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'placeholder', equips: { weapon: cardNamed(registry, 'spear') } },
          { general: 'placeholder' },
        ],
      }),
    )
    expect(weaponRange(ctx, 0)).toBe(1)
    expect(attackRange(ctx, 0)).toBe(1)
  })

  it('attackRange 钩子在武器基值上修正,且只对技能拥有者(subject === owner)生效', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'gLong', equips: { weapon: cardNamed(registry, 'blade') } },
          { general: 'placeholder', equips: { weapon: cardNamed(registry, 'kylin_bow') } },
          { general: 'gLong' },
        ],
      }),
    )
    expect(attackRange(ctx, 0)).toBe(4)
    expect(attackRange(ctx, 1)).toBe(5)
    expect(attackRange(ctx, 2)).toBe(2)
  })

  it('inAttackRange = distance ≤ attackRange', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'placeholder', equips: { weapon: cardNamed(registry, 'blade') } },
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'placeholder' },
        ],
      }),
    )
    // 7 人环:0 → 3 距离 3、0 → 4 距离 3(另一方向)、0 → 2 距离 2;青龙偃月刀射程 3 覆盖全场
    expect([1, 2, 3, 4, 5, 6].map((t) => inAttackRange(ctx, 0, t))).toStrictEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ])
    // 无武器射程 1:只有相邻的 0 与 2
    expect([0, 2, 3, 4, 5, 6].map((t) => inAttackRange(ctx, 1, t))).toStrictEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ])
  })
})

describe('distance 距离', () => {
  const mashu = modifierSkill('mashu', {
    distanceFrom: (_ctx, owner, v, from) => (from === owner ? v - 1 : v),
  })
  const guard = modifierSkill('guard', {
    distanceTo: (_ctx, owner, v, _from, to) => (to === owner ? v + 1 : v),
  })
  const registry = createTestRegistry(
    packageOf(
      [mashu, guard, crossbowSkill],
      [defineGeneral('gMashu', ['mashu']), defineGeneral('gGuard', ['guard'])],
      STANDARD_EQUIPS,
    ),
  )
  const fivePlayers = (): Ctx =>
    ctxOf(
      buildGame(registry, {
        players: [
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'placeholder' },
        ],
      }),
    )

  it('无修正时距离 = 环上两方向取短的座位距离,且对称;到自己为 max(1, 0) = 1', () => {
    const ctx = fivePlayers()
    expect([1, 2, 3, 4].map((t) => distance(ctx, 0, t))).toStrictEqual([1, 2, 2, 1])
    expect([0, 1, 2, 3].map((f) => distance(ctx, f, 4))).toStrictEqual([1, 2, 2, 1])
    expect(distance(ctx, 1, 3)).toBe(2)
    expect(distance(ctx, 3, 1)).toBe(2)
    expect(seatDistance(ctx.state, 0, 0)).toBe(0)
    expect(distance(ctx, 0, 0)).toBe(1)
  })

  it('−1 马只缩短自己计算到他人的距离,且不低于 1', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'placeholder', equips: { horse_offensive: cardNamed(registry, 'chitu') } },
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'placeholder' },
        ],
      }),
    )
    expect([1, 2, 3, 4].map((t) => distance(ctx, 0, t))).toStrictEqual([1, 1, 1, 1])
    // 他人到 0 号位不受影响
    expect([1, 2, 3, 4].map((f) => distance(ctx, f, 0))).toStrictEqual([1, 2, 2, 1])
  })

  it('+1 马只增加他人计算到自己的距离', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'placeholder', equips: { horse_defensive: cardNamed(registry, 'dilu') } },
          { general: 'placeholder' },
          { general: 'placeholder' },
        ],
      }),
    )
    expect([0, 1, 3, 4].map((f) => distance(ctx, f, 2))).toStrictEqual([3, 2, 2, 3])
    expect([0, 1, 3, 4].map((t) => distance(ctx, 2, t))).toStrictEqual([2, 1, 1, 2])
  })

  it('−1 马与 +1 马同时存在时相互抵消;未注册的坐骑(M1 牌堆里的大宛)不产生修正', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'placeholder', equips: { horse_offensive: cardNamed(registry, 'chitu') } },
          { general: 'placeholder' },
          { general: 'placeholder', equips: { horse_defensive: cardNamed(registry, 'dilu') } },
          { general: 'placeholder', equips: { horse_offensive: cardNamed(registry, 'dayuan') } },
          { general: 'placeholder' },
        ],
      }),
    )
    expect(distance(ctx, 0, 2)).toBe(2)
    expect(distance(ctx, 3, 1)).toBe(2)
    expect(distance(ctx, 3, 2)).toBe(2)
  })

  it('死亡玩家不计入环:跳过死者后两侧玩家相邻', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'placeholder' },
          { general: 'placeholder', alive: false },
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'placeholder' },
        ],
      }),
    )
    expect(distance(ctx, 0, 2)).toBe(1)
    expect(distance(ctx, 2, 0)).toBe(1)
    expect(distance(ctx, 0, 3)).toBe(2)
    expect(distance(ctx, 4, 2)).toBe(2)
    // 再死一人(2 号位):环为 0 / 3 / 4,0 → 3 相邻
    const two = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'placeholder' },
          { general: 'placeholder', alive: false },
          { general: 'placeholder', alive: false },
          { general: 'placeholder' },
          { general: 'placeholder' },
        ],
      }),
    )
    expect(distance(two, 0, 3)).toBe(1)
    expect(distance(two, 3, 4)).toBe(1)
    expect(distance(two, 4, 0)).toBe(1)
  })

  it('距离在对局中随死亡实时变化:杀死相邻者后,原本距离 2 的目标进入攻击范围', () => {
    const slash = cardNamed(registry, 'slash')
    const game = buildGame(registry, {
      players: [
        { general: 'placeholder', hand: [slash] },
        { general: 'placeholder', hp: 1 },
        { general: 'placeholder' },
        { general: 'placeholder' },
      ],
      drawPileTop: cardsNamed(registry, 'jink', 2),
    })
    game.start()
    const ctx = ctxOf(game)
    expect(distance(ctx, 0, 2)).toBe(2)
    const before = expectRequest(game, 'play')
    expect(before.usableCards.find((u) => u.card === slash)?.targets.candidates).toStrictEqual([
      1, 3,
    ])
    answer(game, { action: 'useCard', card: slash, targets: [1] })
    expectRequest(game, 'play')
    expect(game.state.players[1]?.alive).toBe(false)
    expect(distance(ctx, 0, 2)).toBe(1)
    expect(inAttackRange(ctx, 0, 2)).toBe(true)
  })

  it('distanceFrom 钩子(马术)与 distanceTo 钩子分别作用于 from / to 视角,与坐骑叠加', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'gMashu' },
          { general: 'placeholder' },
          { general: 'placeholder' },
          { general: 'gGuard' },
          { general: 'placeholder', equips: { horse_offensive: cardNamed(registry, 'chitu') } },
        ],
      }),
    )
    // 马术:0 → 2 由 2 变 1;0 → 3 由 2 变 2(guard +1 抵消);他人 → 0 不变
    expect(distance(ctx, 0, 2)).toBe(1)
    expect(distance(ctx, 0, 3)).toBe(2)
    expect(distance(ctx, 2, 0)).toBe(2)
    // guard:1 → 3 由 2 变 3;3 → 1 不变
    expect(distance(ctx, 1, 3)).toBe(3)
    expect(distance(ctx, 3, 1)).toBe(2)
    // 赤兔 + guard:4 → 3 = 1 − 1 + 1 = 1
    expect(distance(ctx, 4, 3)).toBe(1)
    expect(distance(ctx, 4, 2)).toBe(1)
  })
})

describe('useLimit 使用次数上限', () => {
  const paoxiao = modifierSkill('paoxiao', {
    useLimit: (_ctx, owner, v, subject, card) =>
      subject === owner && card.name === 'slash' ? UNLIMITED : v,
  })
  const registry = createTestRegistry(
    packageOf([paoxiao, crossbowSkill], [defineGeneral('gPaoxiao', ['paoxiao'])], STANDARD_EQUIPS),
  )

  it('杀为 1,其余牌(桃 / 闪 / 未注册的牌)为 UNLIMITED', () => {
    const ctx = ctxOf(
      buildGame(registry, { players: [{ general: 'placeholder' }, { general: 'placeholder' }] }),
    )
    expect(useLimit(ctx, 0, faceNamed(ctx, 'slash'))).toBe(1)
    expect(useLimit(ctx, 0, faceNamed(ctx, 'peach'))).toBe(UNLIMITED)
    expect(useLimit(ctx, 0, faceNamed(ctx, 'jink'))).toBe(UNLIMITED)
    expect(useLimit(ctx, 0, faceNamed(ctx, 'duel'))).toBe(UNLIMITED)
  })

  it('钩子可改为 UNLIMITED:武将技能(咆哮)与装备技能(连弩)都只对拥有者生效', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'gPaoxiao' },
          { general: 'placeholder', equips: { weapon: cardNamed(registry, 'crossbow') } },
          { general: 'placeholder' },
        ],
      }),
    )
    const slash = faceNamed(ctx, 'slash')
    expect(useLimit(ctx, 0, slash)).toBe(UNLIMITED)
    expect(useLimit(ctx, 1, slash)).toBe(UNLIMITED)
    expect(useLimit(ctx, 2, slash)).toBe(1)
  })

  it('出牌阶段:无连弩时第二张杀不可用;有连弩时可以连续使用', () => {
    const slashes = cardsNamed(registry, 'slash', 2)
    const play = (withCrossbow: boolean): Game => {
      const game = buildGame(registry, {
        players: [
          {
            general: 'placeholder',
            hand: [...slashes],
            equips: withCrossbow ? { weapon: cardNamed(registry, 'crossbow') } : {},
          },
          { general: 'placeholder' },
        ],
        drawPileTop: cardsNamed(registry, 'jink', 2),
      })
      game.start()
      const first = expectRequest(game, 'play')
      expect(first.usableCards.map((u) => u.card)).toStrictEqual(slashes)
      answer(game, { action: 'useCard', card: slashes[0] as CardId, targets: [1] })
      return game
    }
    const plain = play(false)
    expect(expectRequest(plain, 'play').usableCards).toStrictEqual([])
    expect(plain.state.players[1]?.hp).toBe(3)

    const armed = play(true)
    expect(expectRequest(armed, 'play').usableCards.map((u) => u.card)).toStrictEqual([slashes[1]])
    answer(armed, { action: 'useCard', card: slashes[1] as CardId, targets: [1] })
    expectRequest(armed, 'play')
    expect(armed.state.players[1]?.hp).toBe(2)
  })
})

describe('usedInPlay 出牌阶段使用次数', () => {
  const registry = createTestRegistry(packageOf([], []))

  it('无回合时为 0', () => {
    const ctx = ctxOf(
      buildGame(registry, { players: [{ general: 'placeholder' }, { general: 'placeholder' }] }),
    )
    expect(ctx.state.turn).toBeNull()
    expect(usedInPlay(ctx, 0, 'slash')).toBe(0)
  })

  it('出牌阶段使用的杀计 1;目标响应使用的闪(reason = response)不计', () => {
    const slash = cardNamed(registry, 'slash')
    const jink = cardNamed(registry, 'jink')
    const game = buildGame(registry, {
      players: [
        { general: 'placeholder', hand: [slash] },
        { general: 'placeholder', hand: [jink] },
      ],
      drawPileTop: cardsNamed(registry, 'peach', 2),
    })
    game.start()
    const ctx = ctxOf(game)
    expect(usedInPlay(ctx, 0, 'slash')).toBe(0)
    answer(game, { action: 'useCard', card: slash, targets: [1] })
    expect(expectRequest(game, 'askCard').player).toBe(1)
    answer(game, { card: jink, viewAs: null, targets: [] })
    expectRequest(game, 'play')
    expect(ctx.state.turn?.history).toStrictEqual([
      { player: 0, card: 'slash', mode: 'use', reason: 'play', phase: 'play' },
      { player: 1, card: 'jink', mode: 'use', reason: 'response', phase: 'play' },
    ])
    expect(usedInPlay(ctx, 0, 'slash')).toBe(1)
    expect(usedInPlay(ctx, 1, 'jink')).toBe(0)
    expect(usedInPlay(ctx, 1, 'slash')).toBe(0)
    expect(game.state.players[1]?.hp).toBe(4)
  })

  it('只统计 reason === "play" 且 mode === "use" 的记录:response / skill / 打出 / 他人的都不计', () => {
    const game = buildGame(registry, {
      players: [{ general: 'placeholder' }, { general: 'placeholder' }],
      drawPileTop: cardsNamed(registry, 'jink', 2),
    })
    game.start()
    expectRequest(game, 'play')
    const ctx = ctxOf(game)
    const turn = ctx.state.turn
    if (turn === null) throw new EngineError('出牌阶段应有回合状态')
    turn.history.push(
      { player: 0, card: 'slash', mode: 'use', reason: 'play', phase: 'play' },
      { player: 0, card: 'slash', mode: 'use', reason: 'response', phase: 'play' },
      { player: 0, card: 'slash', mode: 'use', reason: 'skill', phase: 'play' },
      { player: 0, card: 'slash', mode: 'play', reason: 'response', phase: 'play' },
      { player: 1, card: 'slash', mode: 'use', reason: 'play', phase: 'play' },
      { player: 0, card: 'peach', mode: 'use', reason: 'play', phase: 'play' },
      { player: 0, card: 'slash', mode: 'use', reason: 'play', phase: 'play' },
    )
    expect(usedInPlay(ctx, 0, 'slash')).toBe(2)
    expect(usedInPlay(ctx, 1, 'slash')).toBe(1)
    expect(usedInPlay(ctx, 0, 'peach')).toBe(1)
    expect(usedInPlay(ctx, 0, 'jink')).toBe(0)
  })

  it('回合结束后 history 清空:下一回合的 usedInPlay 从 0 起', () => {
    const slashes = cardsNamed(registry, 'slash', 2)
    const game = buildGame(registry, {
      players: [
        { general: 'placeholder', hand: [slashes[0] as CardId] },
        { general: 'placeholder', hand: [slashes[1] as CardId] },
      ],
      drawPileTop: cardsNamed(registry, 'jink', 4),
    })
    game.start()
    answer(game, { action: 'useCard', card: slashes[0] as CardId, targets: [1] })
    expectRequest(game, 'play')
    expect(usedInPlay(ctxOf(game), 0, 'slash')).toBe(1)
    answer(game, { action: 'end' })
    expect(expectRequest(game, 'play').player).toBe(1)
    const ctx = ctxOf(game)
    expect(ctx.state.turn?.history).toStrictEqual([])
    expect(usedInPlay(ctx, 0, 'slash')).toBe(0)
    expect(usedInPlay(ctx, 1, 'slash')).toBe(0)
  })
})

describe('maxHandCards 手牌上限', () => {
  const plusTwo = modifierSkill('plusTwo', {
    maxHandCards: (_ctx, owner, v, subject) => (subject === owner ? v + 2 : v),
  })
  const registry = createTestRegistry(packageOf([plusTwo], [defineGeneral('gPlus', ['plusTwo'])]))

  it('基值 = 当前体力值(非上限),随体力变化', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'placeholder' },
          { general: 'placeholder', hp: 2 },
          { general: 'placeholder', hp: 1, maxHp: 3 },
        ],
      }),
    )
    expect(maxHandCards(ctx, 0)).toBe(4)
    expect(maxHandCards(ctx, 1)).toBe(2)
    expect(maxHandCards(ctx, 2)).toBe(1)
  })

  it('maxHandCards 钩子只对拥有者生效', () => {
    const ctx = ctxOf(
      buildGame(registry, {
        players: [
          { general: 'gPlus', hp: 2 },
          { general: 'placeholder', hp: 2 },
        ],
      }),
    )
    expect(maxHandCards(ctx, 0)).toBe(4)
    expect(maxHandCards(ctx, 1)).toBe(2)
  })

  it('弃牌阶段按 maxHandCards 要求弃牌:体力 2、手牌 6 ⇒ 弃 4;带 +2 钩子 ⇒ 弃 2;不超出则不询问', () => {
    const jinks = cardsNamed(registry, 'jink', 6)
    const run = (general: string): Game => {
      const game = buildGame(registry, {
        players: [{ general, hp: 2, hand: jinks.slice(0, 4) }, { general: 'placeholder' }],
        drawPileTop: jinks.slice(4),
      })
      game.start()
      expectRequest(game, 'play')
      answer(game, { action: 'end' })
      return game
    }
    const plain = run('placeholder')
    const discard = expectRequest(plain, 'chooseCards')
    expect(discard.player).toBe(0)
    expect(discard.min).toBe(4)
    expect(discard.max).toBe(4)
    expect(discard.candidates.map((c) => c.card)).toStrictEqual(jinks)
    answer(plain, { indices: [0, 1, 2, 3] })
    expect(plain.state.players[0]?.hand).toHaveLength(2)
    expect(expectRequest(plain, 'play').player).toBe(1)

    const boosted = run('gPlus')
    const smaller = expectRequest(boosted, 'chooseCards')
    expect(smaller.min).toBe(2)
    expect(smaller.max).toBe(2)
    answer(boosted, { indices: [4, 5] })
    expect(boosted.state.players[0]?.hand).toStrictEqual(jinks.slice(0, 4))

    // 体力 4、手牌 4 + 摸 2 = 6,再弃到 4 ⇒ 弃 2;改为手牌 2 + 摸 2 = 4 ⇒ 不询问
    const fine = buildGame(registry, {
      players: [{ general: 'placeholder', hand: jinks.slice(0, 2) }, { general: 'placeholder' }],
      drawPileTop: jinks.slice(2, 4),
    })
    fine.start()
    answer(fine, { action: 'end' })
    expect(expectRequest(fine, 'play').player).toBe(1)
    expect(fine.state.players[0]?.hand).toHaveLength(4)
  })
})

describe('legalTargets:prohibitTarget / ignoreDistance / extraTargets', () => {
  const kongcheng = modifierSkill('kongcheng', {
    prohibitTarget: (_ctx, owner, v, _source, target, card) =>
      v || (target === owner && card.name === 'slash'),
  })
  const qicai = modifierSkill('qicai', {
    ignoreDistance: (_ctx, owner, v, subject, card) =>
      v || (subject === owner && card.name === 'slash'),
  })
  const halberd = modifierSkill('halberd', {
    extraTargets: (_ctx, owner, v, subject, card) =>
      subject === owner && card.name === 'slash' ? v + 1 : v,
  })
  const greedy = modifierSkill('greedy', {
    extraTargets: (_ctx, owner, v, subject) => (subject === owner ? v + 5 : v),
  })
  const registry = createTestRegistry(
    packageOf(
      [kongcheng, qicai, halberd, greedy, crossbowSkill],
      [
        defineGeneral('gKongcheng', ['kongcheng']),
        defineGeneral('gQicai', ['qicai']),
        defineGeneral('gHalberd', ['halberd']),
        defineGeneral('gGreedy', ['greedy']),
      ],
      STANDARD_EQUIPS,
    ),
  )
  const slashDef = (): CardDef => {
    const def = registry.card('slash')
    if (def === null) throw new EngineError('杀未注册')
    return def
  }
  /** 五人局:0 号位持一张杀,其余按 generals 给定;摸牌阶段摸到的是闪(出牌阶段不可用) */
  const fiveWith = (generals: [string, string, string, string, string]): Game => {
    const slash = cardNamed(registry, 'slash')
    const game = buildGame(registry, {
      players: generals.map((general, id) => (id === 0 ? { general, hand: [slash] } : { general })),
      drawPileTop: cardsNamed(registry, 'jink', 2),
    })
    game.start()
    return game
  }
  const slashTargets = (game: Game): { candidates: PlayerId[]; min: number; max: number } => {
    const play = expectRequest(game, 'play')
    const usable = play.usableCards.find((u) => u.card === cardNamed(registry, 'slash'))
    if (usable === undefined) throw new EngineError('杀不在可使用列表内')
    return usable.targets
  }

  it('基线:存活、非自己、攻击范围内;play 请求的候选与 legalTargets 一致', () => {
    const game = fiveWith([
      'placeholder',
      'placeholder',
      'placeholder',
      'placeholder',
      'placeholder',
    ])
    const ctx = ctxOf(game)
    const spec = legalTargets(ctx, 0, faceNamed(ctx, 'slash'), slashDef())
    expect(spec).toStrictEqual({ candidates: [1, 4], min: 1, max: 1 })
    expect(slashTargets(game)).toStrictEqual(spec)
  })

  it('死亡玩家不是候选,且其离开存活环后原本不在范围内的玩家进入范围', () => {
    const slash = cardNamed(registry, 'slash')
    const game = buildGame(registry, {
      players: [
        { general: 'placeholder', hand: [slash] },
        { general: 'placeholder' },
        { general: 'placeholder' },
        { general: 'placeholder' },
        { general: 'placeholder', alive: false },
      ],
      drawPileTop: cardsNamed(registry, 'jink', 2),
    })
    game.start()
    expect(slashTargets(game)).toStrictEqual({ candidates: [1, 3], min: 1, max: 1 })
  })

  it('ignoreDistance:拥有者使用杀无距离限制,他人不受影响', () => {
    const game = fiveWith(['gQicai', 'placeholder', 'placeholder', 'placeholder', 'placeholder'])
    const ctx = ctxOf(game)
    expect(slashTargets(game)).toStrictEqual({ candidates: [1, 2, 3, 4], min: 1, max: 1 })
    const face = faceNamed(ctx, 'slash')
    expect(legalTargets(ctx, 1, face, slashDef()).candidates).toStrictEqual([0, 2])
    // 真的能对距离 2 的目标使用
    answer(game, { action: 'useCard', card: cardNamed(registry, 'slash'), targets: [2] })
    expectRequest(game, 'play')
    expect(game.state.players[2]?.hp).toBe(3)
  })

  it('prohibitTarget:被禁止者不出现在候选内,即使在攻击范围内;对其他牌名不生效', () => {
    const game = fiveWith([
      'placeholder',
      'gKongcheng',
      'placeholder',
      'placeholder',
      'placeholder',
    ])
    const ctx = ctxOf(game)
    expect(slashTargets(game)).toStrictEqual({ candidates: [4], min: 1, max: 1 })
    expect(fold(ctx, 'prohibitTarget', false, 0, 1, faceNamed(ctx, 'slash'))).toBe(true)
    expect(fold(ctx, 'prohibitTarget', false, 0, 1, faceNamed(ctx, 'peach'))).toBe(false)
    expect(fold(ctx, 'prohibitTarget', false, 0, 4, faceNamed(ctx, 'slash'))).toBe(false)
    // 校验与候选共用:对被禁止者使用杀是非法应答
    expect(() =>
      answer(game, { action: 'useCard', card: cardNamed(registry, 'slash'), targets: [1] }),
    ).toThrow('非法应答')
  })

  it('prohibitTarget 与 ignoreDistance 叠加:无视距离但仍不能选被禁止者', () => {
    const game = fiveWith(['gQicai', 'placeholder', 'gKongcheng', 'placeholder', 'placeholder'])
    expect(slashTargets(game)).toStrictEqual({ candidates: [1, 3, 4], min: 1, max: 1 })
  })

  it('extraTargets:max 增加、min 与候选不变;两个目标依次结算', () => {
    const game = fiveWith(['gHalberd', 'placeholder', 'placeholder', 'placeholder', 'placeholder'])
    expect(slashTargets(game)).toStrictEqual({ candidates: [1, 4], min: 1, max: 2 })
    answer(game, { action: 'useCard', card: cardNamed(registry, 'slash'), targets: [4, 1] })
    expectRequest(game, 'play')
    expect(game.state.players[1]?.hp).toBe(3)
    expect(game.state.players[4]?.hp).toBe(3)
    // 目标按从使用者起的座位序结算:先 1 后 4(应答里写的是 [4, 1])
    expect(game.log.filter((l) => l.type === 'damage').map((l) => l.data)).toMatchObject([
      { from: 0, to: 1, amount: 1, nature: 'normal' },
      { from: 0, to: 4, amount: 1, nature: 'normal' },
    ])
  })

  it('extraTargets 的 max 不超过候选数;对他人不生效', () => {
    const game = fiveWith(['gGreedy', 'placeholder', 'placeholder', 'placeholder', 'placeholder'])
    const ctx = ctxOf(game)
    expect(slashTargets(game)).toStrictEqual({ candidates: [1, 4], min: 1, max: 2 })
    expect(legalTargets(ctx, 1, faceNamed(ctx, 'slash'), slashDef())).toStrictEqual({
      candidates: [0, 2],
      min: 1,
      max: 1,
    })
    // 三个目标超出 max,非法
    expect(() =>
      answer(game, { action: 'useCard', card: cardNamed(registry, 'slash'), targets: [1, 4, 2] }),
    ).toThrow('非法应答')
  })

  it('武器射程与坐骑经 legalTargets 生效:青龙偃月刀射程 3,目标的 +1 马把它推出射程', () => {
    const slash = cardNamed(registry, 'slash')
    const game = buildGame(registry, {
      players: [
        { general: 'placeholder', hand: [slash], equips: { weapon: cardNamed(registry, 'blade') } },
        { general: 'placeholder' },
        { general: 'placeholder' },
        { general: 'placeholder', equips: { horse_defensive: cardNamed(registry, 'dilu') } },
        { general: 'placeholder' },
        { general: 'placeholder' },
        { general: 'placeholder' },
      ],
      drawPileTop: cardsNamed(registry, 'jink', 2),
    })
    game.start()
    // 青龙偃月刀射程 3:0 → 3 距离 3 + 1(的卢)= 4 超出;0 → 4 距离 3 在射程内
    expect(slashTargets(game)).toStrictEqual({ candidates: [1, 2, 4, 5, 6], min: 1, max: 1 })
  })
})
