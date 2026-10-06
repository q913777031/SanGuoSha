/**
 * trigger.test.ts ─ 触发技的收集、排序与询问(设计 §6 / D8 / §12d)。
 * 用 createTestRegistry 注入假技能与假武将,验证:
 *  优先级桶降序跨玩家;从当前回合玩家起座位序(无回合时从 0 号位,回合玩家已死仍以其座位为起点);
 *  同玩家锁定技先且不询问;多个可选技发 invokeSkill 让玩家选;times() 多次;拒绝后本时机不再问;
 *  发动后重扫;事件取消即终止;死亡玩家默认不参与、triggerWhenDead 开启参与;
 *  skillsOf 顺序 = GeneralDef 声明序 → 额外技能 → 装备槽序(主公技在无身份模式下不参与)。
 * 全部同步脚本式(Game.start / step),固定种子。
 */
import { describe, expect, it } from 'vitest'

import type {
  CardDef,
  CardId,
  CardName,
  ContentPackage,
  Ctx,
  EquipSlot,
  Flow,
  GameConfig,
  GeneralDef,
  PlayerId,
  Registry,
  SkillDef,
  SkillId,
  Timing,
  TimingEventMap,
  TriggerSkill,
} from '../src/index.js'
import {
  EngineError,
  Game,
  InvalidResponseError,
  ask,
  createFlowGuard,
  handlers,
  runEvent,
  skillsOf,
} from '../src/index.js'
import {
  TEST_OPTIONS,
  answer,
  buildGame,
  createTestRegistry,
  expectRequest,
} from '../src/testing/index.js'

/** 假触发技的描述:缺省为可选、priority 0、不随死亡触发、canTrigger 恒真 */
interface SkillSpec<T extends Timing> {
  id: SkillId
  timings: readonly T[]
  priority?: number
  locked?: boolean
  lord?: boolean
  triggerWhenDead?: boolean
  canTrigger?: (ctx: Ctx, ev: TimingEventMap[T], owner: PlayerId) => boolean
  times?: (ctx: Ctx, ev: TimingEventMap[T], owner: PlayerId) => number
  /** 发动时(记录之后)执行的同步副作用:改事件字段、写标记等 */
  onInvoke?: (ctx: Ctx, ev: TimingEventMap[T], owner: PlayerId) => void
  /** 发动时(记录之后)运行的 Flow:嵌套事件、询问玩家等 */
  flow?: (ctx: Ctx, ev: TimingEventMap[T], owner: PlayerId) => Flow<void>
}

/** 构造一个假触发技:每次发动把 `${owner}:${id}` 追加到 records */
function defineSkill<T extends Timing>(records: string[], spec: SkillSpec<T>): TriggerSkill<T> {
  const { times, onInvoke, flow } = spec
  const skill: TriggerSkill<T> = {
    id: spec.id,
    name: spec.id,
    description: `测试触发技 ${spec.id}`,
    type: 'trigger',
    timings: [...spec.timings],
    priority: spec.priority ?? 0,
    locked: spec.locked ?? false,
    lord: spec.lord ?? false,
    triggerWhenDead: spec.triggerWhenDead ?? false,
    canTrigger: spec.canTrigger ?? (() => true),
    *effect(ctx, ev, owner) {
      records.push(`${owner}:${spec.id}`)
      onInvoke?.(ctx, ev, owner)
      if (flow !== undefined) yield* flow(ctx, ev, owner)
    },
  }
  if (times !== undefined) skill.times = times
  return skill
}

/** 假武将:4 血、魏、男,技能按给定顺序声明 */
function defineGeneral(id: string, skills: SkillId[]): GeneralDef {
  return { id, name: id, kingdom: 'wei', gender: 'male', maxHp: 4, skills }
}

/** 带技能的假装备牌(不能主动使用,只为 equip.skills 参与 skillsOf) */
function equipCard(name: CardName, slot: EquipSlot, skills: SkillId[]): CardDef {
  return {
    name,
    type: 'equip',
    equip: {
      slot,
      range: slot === 'weapon' ? 1 : null,
      distance: slot === 'horse_offensive' ? -1 : slot === 'horse_defensive' ? 1 : null,
      skills,
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
  return { name: 'test-trigger', version: '0.0.0', skills, generals, cards }
}

/** 牌表中第 nth 张名为 name 的牌 id */
function cardNamed(registry: Registry, name: CardName, nth = 0): CardId {
  const ids = registry.deck.filter((c) => c.name === name).map((c) => c.id)
  const id = ids[nth]
  if (id === undefined) throw new EngineError(`牌表中没有第 ${nth} 张 ${name}`)
  return id
}

/** 只读查询用的 Ctx(skillsOf 只读 state 与 registry;其余成员为不可用的占位实现) */
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

/** 当前结算栈上唯一的 Turn 事件 id(Turn.start 等待点) */
function turnEventId(game: Game): number {
  const top = game.state.stack[0]
  if (top === undefined || top.kind !== 'Turn') throw new EngineError('结算栈顶不是 Turn 事件')
  expect(game.state.stack).toHaveLength(1)
  return top.id
}

describe('优先级桶(priority 降序、跨玩家)', () => {
  it('大者先,桶内从当前回合玩家起座位序;registry 预建的桶降序且恒含 0', () => {
    const records: string[] = []
    const skills = [
      defineSkill(records, { id: 'a0', timings: ['Turn.start'], locked: true }),
      defineSkill(records, { id: 'a10', timings: ['Turn.start'], locked: true, priority: 10 }),
      defineSkill(records, { id: 'b10', timings: ['Turn.start'], locked: true, priority: 10 }),
      defineSkill(records, { id: 'cNeg5', timings: ['Turn.start'], locked: true, priority: -5 }),
      defineSkill(records, { id: 'c0', timings: ['Turn.start'], locked: true }),
    ]
    const registry = createTestRegistry(
      packageOf(skills, [
        defineGeneral('gA', ['a0', 'a10']),
        defineGeneral('gB', ['b10']),
        defineGeneral('gC', ['cNeg5', 'c0']),
      ]),
    )
    expect(registry.triggerPriorities('Turn.start')).toStrictEqual([10, 0, -5])
    expect(registry.triggerPriorities('Turn.end')).toStrictEqual([0])

    // lastTurnPlayer = 0 ⇒ 本回合玩家为 1 号位
    const game = buildGame(registry, {
      players: [{ general: 'gA' }, { general: 'gB' }, { general: 'gC' }],
      lastTurnPlayer: 0,
    })
    game.start()
    expect(expectRequest(game, 'play').player).toBe(1)
    expect(records).toStrictEqual(['1:b10', '0:a10', '2:c0', '0:a0', '2:cNeg5'])
  })

  it('priority 对可选技只影响桶:高桶先单独询问,低桶稍后再问,不在同一个 invokeSkill 里', () => {
    const records: string[] = []
    const skills = [
      defineSkill(records, { id: 'x5', timings: ['Turn.start'], priority: 5 }),
      defineSkill(records, { id: 'y0', timings: ['Turn.start'] }),
      defineSkill(records, { id: 'z0', timings: ['Turn.start'] }),
    ]
    const registry = createTestRegistry(packageOf(skills, [defineGeneral('g', ['y0', 'x5', 'z0'])]))
    const game = buildGame(registry, { players: [{ general: 'g' }, { general: 'g' }] })
    game.start()
    const first = expectRequest(game, 'invokeSkill')
    expect(first.player).toBe(0)
    expect(first.skills).toStrictEqual(['x5'])
    answer(game, { skill: null })
    // 高桶的 1 号位
    const second = expectRequest(game, 'invokeSkill')
    expect(second.player).toBe(1)
    expect(second.skills).toStrictEqual(['x5'])
    answer(game, { skill: 'x5' })
    // 回到 0 桶:同桶的两个可选技在同一个请求里,按 skillsOf 顺序
    const third = expectRequest(game, 'invokeSkill')
    expect(third.player).toBe(0)
    expect(third.skills).toStrictEqual(['y0', 'z0'])
    answer(game, { skill: null })
    const fourth = expectRequest(game, 'invokeSkill')
    expect(fourth.player).toBe(1)
    expect(fourth.skills).toStrictEqual(['y0', 'z0'])
    answer(game, { skill: null })
    expectRequest(game, 'play')
    expect(records).toStrictEqual(['1:x5'])
  })
})

describe('座位序(从当前回合玩家起顺时针)', () => {
  it('回合玩家为 2 号位时顺序 2 → 0 → 1;下一回合从 0 号位起', () => {
    const records: string[] = []
    const registry = createTestRegistry(
      packageOf(
        [defineSkill(records, { id: 'mark', timings: ['Turn.start'], locked: true })],
        [defineGeneral('g', ['mark'])],
      ),
    )
    const game = buildGame(registry, {
      players: [{ general: 'g' }, { general: 'g' }, { general: 'g' }],
      lastTurnPlayer: 1,
    })
    game.start()
    expect(expectRequest(game, 'play').player).toBe(2)
    expect(records).toStrictEqual(['2:mark', '0:mark', '1:mark'])
    answer(game, { action: 'end' })
    expect(expectRequest(game, 'play').player).toBe(0)
    expect(records.slice(3)).toStrictEqual(['0:mark', '1:mark', '2:mark'])
  })

  it('无回合时(Game.start 时机)从 0 号位起', () => {
    const records: string[] = []
    const registry = createTestRegistry(
      packageOf(
        [defineSkill(records, { id: 'gs', timings: ['Game.start'], locked: true })],
        [defineGeneral('g', ['gs'])],
      ),
    )
    const config: GameConfig = {
      seed: 7,
      mode: 'ffa',
      players: [{ general: 'g' }, { general: 'g' }, { general: 'g' }],
      fixedDeckOrder: null,
      options: { ...TEST_OPTIONS },
    }
    const game = new Game(config, registry)
    expect(game.state.turn).toBeNull()
    game.start()
    expect(records).toStrictEqual(['0:gs', '1:gs', '2:gs'])
  })

  it('回合玩家在自己回合内死亡后,仍以其座位为起点(Death.after 顺序 1 → 2 → 0)', () => {
    const records: string[] = []
    const deathRec = defineSkill(records, {
      id: 'deathRec',
      timings: ['Death.after'],
      locked: true,
      triggerWhenDead: true,
    })
    // 受到伤害后对来源造成 4 点伤害:令回合玩家在自己回合内死亡
    const counter = defineSkill(records, {
      id: 'counter',
      timings: ['Damage.done'],
      locked: true,
      canTrigger: (_ctx, ev, owner) => ev.to === owner && ev.from !== null,
      *flow(ctx, ev, owner) {
        if (ev.from === null) return
        yield* runEvent(ctx, {
          kind: 'Damage',
          from: owner,
          to: ev.from,
          amount: 4,
          nature: 'normal',
          card: null,
          causeId: ev.id,
        })
      },
    })
    const registry = createTestRegistry(
      packageOf(
        [deathRec, counter],
        [defineGeneral('gRec', ['deathRec']), defineGeneral('gCounter', ['deathRec', 'counter'])],
      ),
    )
    const slash = cardNamed(registry, 'slash')
    const game = buildGame(registry, {
      players: [{ general: 'gRec' }, { general: 'gRec', hand: [slash] }, { general: 'gCounter' }],
      lastTurnPlayer: 0,
    })
    game.start()
    const play = expectRequest(game, 'play')
    expect(play.player).toBe(1)
    const usable = play.usableCards.find((u) => u.card === slash)
    expect(usable?.targets.candidates).toStrictEqual([0, 2])
    answer(game, { action: 'useCard', card: slash, targets: [2] })
    // 1 号位已死亡,下一回合是 2 号位
    expect(expectRequest(game, 'play').player).toBe(2)
    expect(game.state.players[1]?.alive).toBe(false)
    expect(game.state.players[2]?.hp).toBe(3)
    expect(records).toStrictEqual(['2:counter', '1:deathRec', '2:deathRec', '0:deathRec'])
  })
})

describe('同一玩家:锁定技先且不询问,可选技由 invokeSkill 选', () => {
  const setup = (): { game: Game; records: string[] } => {
    const records: string[] = []
    const skills = [
      defineSkill(records, { id: 'opt1', timings: ['Turn.start'] }),
      defineSkill(records, { id: 'lockA', timings: ['Turn.start'], locked: true }),
      defineSkill(records, { id: 'opt2', timings: ['Turn.start'] }),
      defineSkill(records, { id: 'lockB', timings: ['Turn.start'], locked: true }),
    ]
    const registry = createTestRegistry(
      packageOf(skills, [defineGeneral('gMix', ['opt1', 'lockA', 'opt2', 'lockB'])]),
    )
    const game = buildGame(registry, { players: [{ general: 'gMix' }, { general: 'gMix' }] })
    return { game, records }
  }

  it('锁定技按 skillsOf 顺序先发动、不产生 Request、写 skillInvoked 日志;之后一次 invokeSkill 列出全部可选技', () => {
    const { game, records } = setup()
    game.start()
    const req = expectRequest(game, 'invokeSkill')
    expect(records).toStrictEqual(['0:lockA', '0:lockB'])
    expect(game.responses).toHaveLength(0)
    const turnId = turnEventId(game)
    expect(req.player).toBe(0)
    expect(req.skills).toStrictEqual(['opt1', 'opt2'])
    expect(req.event).toBe(turnId)
    expect(req.reason).toBe(turnId)
    expect(game.log.filter((l) => l.type === 'skillInvoked').map((l) => l.data)).toStrictEqual([
      { player: 0, skill: 'lockA', eventId: turnId, timing: 'Turn.start' },
      { player: 0, skill: 'lockB', eventId: turnId, timing: 'Turn.start' },
    ])
  })

  it('玩家选先发动哪个:发动后重扫,再问剩下的那个', () => {
    const { game, records } = setup()
    game.start()
    answer(game, { skill: 'opt2' })
    expect(records).toStrictEqual(['0:lockA', '0:lockB', '0:opt2'])
    const again = expectRequest(game, 'invokeSkill')
    expect(again.player).toBe(0)
    expect(again.skills).toStrictEqual(['opt1'])
    answer(game, { skill: 'opt1' })
    // 轮到 1 号位:锁定技先发动(无请求),再问可选技
    const next = expectRequest(game, 'invokeSkill')
    expect(next.player).toBe(1)
    expect(next.skills).toStrictEqual(['opt1', 'opt2'])
    expect(records).toStrictEqual(['0:lockA', '0:lockB', '0:opt2', '0:opt1', '1:lockA', '1:lockB'])
    expect(game.log.filter((l) => l.type === 'skillInvoked')).toHaveLength(6)
  })

  it('非法应答(技能不在候选内)按 throw 策略抛错且生成器不前进', () => {
    const { game, records } = setup()
    game.start()
    const before = expectRequest(game, 'invokeSkill')
    expect(() => answer(game, { skill: 'lockA' })).toThrow(InvalidResponseError)
    expect(game.pending).toBe(before)
    expect(records).toStrictEqual(['0:lockA', '0:lockB'])
    expect(game.responses).toHaveLength(0)
    answer(game, { skill: null })
    expect(expectRequest(game, 'invokeSkill').player).toBe(1)
  })

  it('单个可选技 = 是否发动;技能效果中的询问在触发循环内正常进行', () => {
    const records: string[] = []
    const chooser = defineSkill(records, {
      id: 'chooser',
      timings: ['Turn.start'],
      *flow(ctx, ev, owner) {
        const r = yield* ask(ctx, {
          kind: 'choice',
          player: owner,
          options: ['a', 'b'],
          cancellable: false,
          reason: ev.id,
          prompt: { key: 'test.choice', args: {} },
        })
        records.push(`choice:${r.option}`)
      },
    })
    const after = defineSkill(records, { id: 'after', timings: ['Turn.start'], locked: true })
    const registry = createTestRegistry(
      packageOf([chooser, after], [defineGeneral('g', ['chooser']), defineGeneral('h', ['after'])]),
    )
    const game = buildGame(registry, { players: [{ general: 'g' }, { general: 'h' }] })
    game.start()
    const req = expectRequest(game, 'invokeSkill')
    expect(req.skills).toStrictEqual(['chooser'])
    answer(game, { skill: 'chooser' })
    const choice = expectRequest(game, 'choice')
    expect(choice.player).toBe(0)
    expect(choice.options).toStrictEqual(['a', 'b'])
    answer(game, { option: 'b' })
    expectRequest(game, 'play')
    expect(records).toStrictEqual(['0:chooser', 'choice:b', '1:after'])
  })
})

describe('times():同一事件同一时机多次发动', () => {
  it('锁定技 times = 3 连续发动三次后停止', () => {
    const records: string[] = []
    const registry = createTestRegistry(
      packageOf(
        [defineSkill(records, { id: 't3', timings: ['Turn.start'], locked: true, times: () => 3 })],
        [defineGeneral('g', ['t3'])],
      ),
    )
    const game = buildGame(registry, { players: [{ general: 'g' }, { general: 'g' }] })
    game.start()
    expectRequest(game, 'play')
    expect(records).toStrictEqual(['0:t3', '0:t3', '0:t3', '1:t3', '1:t3', '1:t3'])
  })

  it('可选技 times = 2:发动后再问一次,第二次发动后不再问', () => {
    const records: string[] = []
    const registry = createTestRegistry(
      packageOf(
        [defineSkill(records, { id: 'o2', timings: ['Turn.start'], times: () => 2 })],
        [defineGeneral('g', ['o2'])],
      ),
    )
    const game = buildGame(registry, { players: [{ general: 'g' }, { general: 'placeholder' }] })
    game.start()
    expect(expectRequest(game, 'invokeSkill').skills).toStrictEqual(['o2'])
    answer(game, { skill: 'o2' })
    expect(expectRequest(game, 'invokeSkill').skills).toStrictEqual(['o2'])
    answer(game, { skill: 'o2' })
    expectRequest(game, 'play')
    expect(records).toStrictEqual(['0:o2', '0:o2'])
  })

  it('可选技 times = 2:第二次拒绝后本时机不再问', () => {
    const records: string[] = []
    const registry = createTestRegistry(
      packageOf(
        [defineSkill(records, { id: 'o2', timings: ['Turn.start'], times: () => 2 })],
        [defineGeneral('g', ['o2'])],
      ),
    )
    const game = buildGame(registry, { players: [{ general: 'g' }, { general: 'placeholder' }] })
    game.start()
    answer(game, { skill: 'o2' })
    expectRequest(game, 'invokeSkill')
    answer(game, { skill: null })
    expectRequest(game, 'play')
    expect(records).toStrictEqual(['0:o2'])
  })

  it('times 读事件数据(伤害点数):Damage.caused 改量为 2 后,Damage.done 的技能发动两次', () => {
    const records: string[] = []
    const boost = defineSkill(records, {
      id: 'boost',
      timings: ['Damage.caused'],
      locked: true,
      canTrigger: (_ctx, ev, owner) => ev.from === owner,
      onInvoke: (_ctx, ev) => {
        ev.amount = 2
      },
    })
    const yiji = defineSkill(records, {
      id: 'yiji',
      timings: ['Damage.done'],
      locked: true,
      canTrigger: (_ctx, ev, owner) => ev.to === owner,
      times: (_ctx, ev) => ev.amount,
    })
    const registry = createTestRegistry(
      packageOf(
        [boost, yiji],
        [defineGeneral('gBoost', ['boost']), defineGeneral('gYiji', ['yiji'])],
      ),
    )
    const slash = cardNamed(registry, 'slash')
    const game = buildGame(registry, {
      players: [{ general: 'gBoost', hand: [slash] }, { general: 'gYiji' }],
    })
    game.start()
    expect(expectRequest(game, 'play').player).toBe(0)
    answer(game, { action: 'useCard', card: slash, targets: [1] })
    expectRequest(game, 'play')
    expect(game.state.players[1]?.hp).toBe(2)
    expect(records).toStrictEqual(['0:boost', '1:yiji', '1:yiji'])
  })
})

describe('拒绝后本时机不再问(declined 永久)', () => {
  it('一次拒绝使请求里的全部可选技都不再问;下一个时机(下回合)重新询问', () => {
    const records: string[] = []
    const skills = [
      defineSkill(records, { id: 'p', timings: ['Turn.start'] }),
      defineSkill(records, { id: 'q', timings: ['Turn.start'] }),
    ]
    const registry = createTestRegistry(packageOf(skills, [defineGeneral('g', ['p', 'q'])]))
    const game = buildGame(registry, { players: [{ general: 'g' }, { general: 'placeholder' }] })
    game.start()
    expect(expectRequest(game, 'invokeSkill').skills).toStrictEqual(['p', 'q'])
    answer(game, { skill: null })
    expect(expectRequest(game, 'play').player).toBe(0)
    expect(records).toStrictEqual([])
    expect(game.responses).toHaveLength(1)
    // 下回合(1 号位)的 Turn.start:0 号位再次被问
    answer(game, { action: 'end' })
    const again = expectRequest(game, 'invokeSkill')
    expect(again.player).toBe(0)
    expect(again.skills).toStrictEqual(['p', 'q'])
  })

  it('他人发动引起的重扫不会重新询问已拒绝的技能', () => {
    const records: string[] = []
    const skills = [
      defineSkill(records, { id: 'x', timings: ['Turn.start'] }),
      defineSkill(records, { id: 'y', timings: ['Turn.start'], locked: true }),
    ]
    const registry = createTestRegistry(
      packageOf(skills, [defineGeneral('gX', ['x']), defineGeneral('gY', ['y'])]),
    )
    const game = buildGame(registry, { players: [{ general: 'gX' }, { general: 'gY' }] })
    game.start()
    expect(expectRequest(game, 'invokeSkill').player).toBe(0)
    answer(game, { skill: null })
    // y 发动后重扫:x 已拒绝,直接进入出牌阶段
    expect(expectRequest(game, 'play').player).toBe(0)
    expect(records).toStrictEqual(['1:y'])
    expect(game.responses).toHaveLength(1)
  })
})

describe('发动后重扫(从当前回合玩家起,已发动 / 已拒绝的被跳过)', () => {
  it('后座玩家的技能改变状态后,前座玩家原本不满足条件的技能被重新扫到', () => {
    const records: string[] = []
    const late = defineSkill(records, {
      id: 'late',
      timings: ['Turn.start'],
      canTrigger: (ctx) => ctx.state.flags['ready'] === true,
    })
    const setter = defineSkill(records, {
      id: 'setter',
      timings: ['Turn.start'],
      locked: true,
      onInvoke: (ctx) => {
        ctx.state.flags['ready'] = true
      },
    })
    const registry = createTestRegistry(
      packageOf(
        [late, setter],
        [defineGeneral('gLate', ['late']), defineGeneral('gSet', ['setter'])],
      ),
    )
    const game = buildGame(registry, { players: [{ general: 'gLate' }, { general: 'gSet' }] })
    game.start()
    const req = expectRequest(game, 'invokeSkill')
    expect(req.player).toBe(0)
    expect(req.skills).toStrictEqual(['late'])
    expect(records).toStrictEqual(['1:setter'])
    answer(game, { skill: 'late' })
    expectRequest(game, 'play')
    expect(records).toStrictEqual(['1:setter', '0:late'])
  })

  it('重扫回到回合玩家:0 号位的锁定技依赖 2 号位写入的标记,发动顺序 1 → 2 → 0;已发动的不重复', () => {
    const records: string[] = []
    const a = defineSkill(records, {
      id: 'a',
      timings: ['Turn.start'],
      locked: true,
      canTrigger: (ctx) => ctx.state.flags['ready'] === true,
    })
    const b = defineSkill(records, { id: 'b', timings: ['Turn.start'], locked: true })
    const c = defineSkill(records, {
      id: 'c',
      timings: ['Turn.start'],
      locked: true,
      onInvoke: (ctx) => {
        ctx.state.flags['ready'] = true
      },
    })
    const registry = createTestRegistry(
      packageOf(
        [a, b, c],
        [defineGeneral('gA', ['a']), defineGeneral('gB', ['b']), defineGeneral('gC', ['c'])],
      ),
    )
    const game = buildGame(registry, {
      players: [{ general: 'gA' }, { general: 'gB' }, { general: 'gC' }],
    })
    game.start()
    expectRequest(game, 'play')
    expect(records).toStrictEqual(['1:b', '2:c', '0:a'])
  })
})

describe('事件取消即终止', () => {
  it('高桶技能取消 Phase.before 后,同桶 / 低桶、同玩家 / 他人的技能都不再发动,阶段被跳过', () => {
    const records: string[] = []
    const cancelDraw = defineSkill(records, {
      id: 'cancelDraw',
      timings: ['Phase.before'],
      locked: true,
      priority: 5,
      canTrigger: (ctx, ev) => ev.phase === 'draw' && ctx.state.turnCount === 1,
      onInvoke: (_ctx, ev) => {
        ev.cancelled = true
      },
    })
    const rec = defineSkill(records, {
      id: 'rec',
      timings: ['Phase.before'],
      locked: true,
      canTrigger: (_ctx, ev) => ev.phase === 'draw',
    })
    const skipped = defineSkill(records, {
      id: 'skipped',
      timings: ['Phase.skipped'],
      locked: true,
      canTrigger: (_ctx, ev, owner) => ev.player === owner,
    })
    const registry = createTestRegistry(
      packageOf(
        [cancelDraw, rec, skipped],
        [
          defineGeneral('gCancel', ['cancelDraw', 'rec', 'skipped']),
          defineGeneral('gRec', ['rec']),
        ],
      ),
    )
    const game = buildGame(registry, { players: [{ general: 'gCancel' }, { general: 'gRec' }] })
    game.start()
    expect(expectRequest(game, 'play').player).toBe(0)
    // 第 1 回合:取消后 rec 不发动,摸牌阶段被跳过(手牌仍为空)
    expect(records).toStrictEqual(['0:cancelDraw', '0:skipped'])
    expect(game.state.players[0]?.hand).toStrictEqual([])
    // 第 2 回合(1 号位):不取消,rec 从回合玩家起发动,正常摸牌
    answer(game, { action: 'end' })
    expect(expectRequest(game, 'play').player).toBe(1)
    expect(records.slice(2)).toStrictEqual(['1:rec', '0:rec'])
    expect(game.state.players[1]?.hand).toHaveLength(2)
  })

  it('同桶内前座玩家取消后,后座玩家的技能不再发动', () => {
    const records: string[] = []
    const cancel = defineSkill(records, {
      id: 'cancel',
      timings: ['DrawCards.before'],
      locked: true,
      canTrigger: (_ctx, ev) => ev.reason === 'phase',
      onInvoke: (_ctx, ev) => {
        ev.cancelled = true
      },
    })
    const rec = defineSkill(records, {
      id: 'rec',
      timings: ['DrawCards.before'],
      locked: true,
      canTrigger: (_ctx, ev) => ev.reason === 'phase',
    })
    const registry = createTestRegistry(
      packageOf(
        [cancel, rec],
        [defineGeneral('gCancel', ['cancel']), defineGeneral('gRec', ['rec'])],
      ),
    )
    const game = buildGame(registry, { players: [{ general: 'gCancel' }, { general: 'gRec' }] })
    game.start()
    expect(expectRequest(game, 'play').player).toBe(0)
    expect(records).toStrictEqual(['0:cancel'])
    expect(game.state.players[0]?.hand).toStrictEqual([])
  })
})

describe('死亡玩家', () => {
  it('默认不参与;triggerWhenDead 开启的技能(锁定 / 可选)照常参与', () => {
    const records: string[] = []
    const skills = [
      defineSkill(records, { id: 'rec', timings: ['Turn.start'], locked: true }),
      defineSkill(records, { id: 'deadNo', timings: ['Turn.start'], locked: true }),
      defineSkill(records, {
        id: 'deadYes',
        timings: ['Turn.start'],
        locked: true,
        triggerWhenDead: true,
      }),
      defineSkill(records, { id: 'deadOpt', timings: ['Turn.start'], triggerWhenDead: true }),
      defineSkill(records, { id: 'deadOptNo', timings: ['Turn.start'] }),
    ]
    const registry = createTestRegistry(
      packageOf(skills, [
        defineGeneral('gAlive', ['rec']),
        defineGeneral('gDead', ['deadNo', 'deadYes', 'deadOptNo', 'deadOpt']),
      ]),
    )
    const game = buildGame(registry, {
      players: [
        { general: 'gAlive' },
        { general: 'gDead', alive: false, hp: 0 },
        { general: 'gAlive' },
      ],
    })
    game.start()
    const req = expectRequest(game, 'invokeSkill')
    expect(req.player).toBe(1)
    expect(req.skills).toStrictEqual(['deadOpt'])
    expect(records).toStrictEqual(['0:rec', '1:deadYes'])
    answer(game, { skill: 'deadOpt' })
    expect(expectRequest(game, 'play').player).toBe(0)
    expect(records).toStrictEqual(['0:rec', '1:deadYes', '1:deadOpt', '2:rec'])
  })
})

describe('skillsOf 顺序 = GeneralDef 声明序 → 额外技能 → 装备槽序', () => {
  const setup = (): { game: Game; records: string[] } => {
    const records: string[] = []
    const mk = (id: string, lord = false): TriggerSkill<'Turn.start'> =>
      defineSkill(records, { id, timings: ['Turn.start'], locked: true, lord })
    // 注册顺序故意与期望顺序相反:顺序必须来自声明序与槽序,而非注册序
    const skills = [
      mk('eqHorseDef'),
      mk('eqHorseOff'),
      mk('eqArmor'),
      mk('eqWeapon'),
      mk('extra'),
      mk('g2'),
      mk('lordOnly', true),
      mk('g1'),
    ]
    const cards = [
      equipCard('dilu', 'horse_defensive', ['eqHorseDef']),
      equipCard('chitu', 'horse_offensive', ['eqHorseOff']),
      equipCard('eight_diagram', 'armor', ['eqArmor']),
      equipCard('crossbow', 'weapon', ['eqWeapon']),
    ]
    const registry = createTestRegistry(
      packageOf(skills, [defineGeneral('g', ['g1', 'lordOnly', 'g2'])], cards),
    )
    const game = buildGame(registry, {
      players: [
        {
          general: 'g',
          skills: ['g1', 'lordOnly', 'g2', 'extra'],
          equips: {
            horse_defensive: cardNamed(registry, 'dilu'),
            horse_offensive: cardNamed(registry, 'chitu'),
            armor: cardNamed(registry, 'eight_diagram'),
            weapon: cardNamed(registry, 'crossbow'),
          },
        },
        { general: 'g' },
      ],
    })
    return { game, records }
  }

  it('skillsOf 直接查询:声明序 → 额外技能 → weapon / armor / horse_offensive / horse_defensive;主公技在 ffa 不参与', () => {
    const { game } = setup()
    const ctx = ctxOf(game)
    expect(skillsOf(ctx, 0).map((s) => s.id)).toStrictEqual([
      'g1',
      'g2',
      'extra',
      'eqWeapon',
      'eqArmor',
      'eqHorseOff',
      'eqHorseDef',
    ])
    expect(skillsOf(ctx, 1).map((s) => s.id)).toStrictEqual(['g1', 'g2'])
    // 装备技能由 equips 现算,不写入 PlayerState.skills
    expect(game.state.players[0]?.skills).toStrictEqual(['g1', 'lordOnly', 'g2', 'extra'])
  })

  it('触发顺序与 skillsOf 一致', () => {
    const { game, records } = setup()
    game.start()
    expectRequest(game, 'play')
    expect(records).toStrictEqual([
      '0:g1',
      '0:g2',
      '0:extra',
      '0:eqWeapon',
      '0:eqArmor',
      '0:eqHorseOff',
      '0:eqHorseDef',
      '1:g1',
      '1:g2',
    ])
  })
})
