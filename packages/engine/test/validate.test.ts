/**
 * validate.test.ts ─ core/validate.ts 的应答校验与默认应答(设计 §5.1 / §5.2)。
 *
 * 覆盖:
 *  - 7 种 Request(play / askCard / chooseCards / choosePlayers / choice / invokeSkill / arrange)各自的
 *    合法 / 非法应答:id 不匹配、kind 不匹配、牌不在候选、目标不在候选 / 数量越界、indices 越界 / 重复、
 *    option 不在列表、skill 不在列表、arrange 未全覆盖 / 槽位越界 / 未知槽位;
 *  - invalidResponsePolicy = 'throw':抛 InvalidResponseError、生成器不前进、pending 不变、可重发同一 Request;
 *  - invalidResponsePolicy = 'default':defaultResponse 被记录为生效应答、写 invalidResponse 日志、回放只认生效应答;
 *  - defaultResponse 对每种 kind 的确定值,且恒为合法应答。
 *
 * 驱动方式:全部同步脚本式(Game.start / step),固定种子。M1 引擎自身只会发出 play / askCard / chooseCards /
 * invokeSkill 四种请求,其余三种(以及带 TargetSpec 的 askCard、可取消的 chooseCards)通过"探针技能"在
 * 0 号玩家的 Turn.start 时机直接 ask() 产生,应答原样记录供断言。
 */
import { describe, expect, it } from 'vitest'

import type {
  ArrangeRequest,
  AskCardRequest,
  ChooseCardsRequest,
  ChoosePlayersRequest,
  ChoiceRequest,
  CardId,
  ContentPackage,
  Ctx,
  EngineOptions,
  EventId,
  Flow,
  InvokeSkillRequest,
  PlayRequest,
  PlayerId,
  Registry,
  Request,
  Response,
  TriggerSkill,
} from '../src/index.js'
import {
  EngineError,
  Game,
  InvalidResponseError,
  ask,
  byName,
  createFlowGuard,
  createStandardRegistry,
  defaultResponse,
  handCandidates,
  handlers,
  validateResponse,
} from '../src/index.js'
import type { StateSpec } from '../src/testing/index.js'
import {
  TEST_OPTIONS,
  answer,
  buildGame,
  createTestRegistry,
  expectRequest,
} from '../src/testing/index.js'

// ───────────────────────────── 牌 id 查询 ─────────────────────────────

/** 只用于按牌名查 id 的基准注册表(牌表与测试注册表一致) */
const BASE: Registry = createStandardRegistry()

/** 牌表中第 index 张名为 name 的牌 */
function card(name: string, index: number): CardId {
  const found = BASE.deck.filter((s) => s.name === name).map((s) => s.id)
  const id = found[index]
  if (id === undefined) throw new EngineError(`牌表中没有第 ${index} 张 ${name}`)
  return id
}

const S0 = card('slash', 0)
const S1 = card('slash', 1)
const S2 = card('slash', 2)
const J0 = card('jink', 0)
const P0 = card('peach', 0)
/** M1 未注册的锦囊:可摸可弃不可使用,用来固定摸牌阶段摸到的牌 */
const N0 = card('nullification', 0)
const N1 = card('nullification', 1)
/** 牌表外的 id */
const NOT_A_CARD = 100_000

// ───────────────────────────── 通用夹具 ─────────────────────────────

/** 取当前 pending 请求(无则失败) */
function requirePending(game: Game): Request {
  const pending = game.pending
  if (pending === null) throw new EngineError('当前没有待应答的请求')
  return pending
}

/**
 * 以当前 pending 的 kind / id 组装一条应答,再用 body 覆盖任意字段(含 kind / requestId),
 * 不做类型检查:用于构造结构不合法、种类不匹配、id 不匹配的应答。
 */
function raw(game: Game, body: Record<string, unknown>): Response {
  const pending = requirePending(game)
  return { kind: pending.kind, requestId: pending.id, ...body } as unknown as Response
}

/**
 * throw 策略下断言一条应答非法:抛 InvalidResponseError(reason 匹配 pattern)、
 * pending 仍是同一个请求对象、状态哈希不变、不记录应答、不写日志 —— 即生成器完全没有前进。
 */
function expectRejected(game: Game, response: Response, pattern?: RegExp): void {
  const pending = requirePending(game)
  const hash = game.stateHash()
  const responses = game.responses.length
  const logs = game.log.length
  let caught: unknown = null
  try {
    game.step(response)
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(InvalidResponseError)
  if (pattern !== undefined && caught instanceof InvalidResponseError) {
    expect(caught.reason).toMatch(pattern)
  }
  expect(game.pending).toBe(pending)
  expect(game.stateHash()).toBe(hash)
  expect(game.responses).toHaveLength(responses)
  expect(game.log).toHaveLength(logs)
}

/** 只读查询用的 Ctx(validateResponse / defaultResponse 只读 state 与 registry;其余成员为占位实现) */
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

/** 三名存活的占位武将玩家(0 号可按需覆盖) */
function threePlayers(first: StateSpec['players'][number] = {}): StateSpec['players'] {
  return [first, {}, {}]
}

// ───────────────────────────── 探针夹具 ─────────────────────────────

const PROBE_GENERAL = 'validate_probe_general'
const PROBE_SKILL = 'validate_probe'

/** 探针体:在 0 号玩家的 Turn.start 时机以引擎上下文发出一个请求并返回应答 */
type ProbeBody = (ctx: Ctx, owner: PlayerId, reason: EventId) => Flow<Response>

/** 含探针技能的注册表;探针收到的(生效)应答依次写入 received */
function probeRegistry(body: ProbeBody): { registry: Registry; received: Response[] } {
  const received: Response[] = []
  const probe: TriggerSkill<'Turn.start'> = {
    id: PROBE_SKILL,
    name: '探针',
    description: '回合开始时发出一个请求并记录应答',
    locked: true,
    lord: false,
    type: 'trigger',
    timings: ['Turn.start'],
    priority: 0,
    triggerWhenDead: false,
    canTrigger(_ctx, ev, owner) {
      return ev.player === owner
    },
    *effect(ctx, ev, owner) {
      received.push(yield* body(ctx, owner, ev.id))
    },
  }
  const pkg: ContentPackage = {
    name: 'validate-test',
    version: '0.0.0',
    skills: [probe],
    generals: [
      {
        id: PROBE_GENERAL,
        name: '探针武将',
        kingdom: 'wei',
        gender: 'male',
        maxHp: 4,
        skills: [PROBE_SKILL],
      },
    ],
  }
  return { registry: createTestRegistry(pkg), received }
}

/** 三人局:0 号持探针武将;start 后停在探针发出的请求上 */
function probeGame(
  body: ProbeBody,
  options: Partial<EngineOptions> = {},
  hand: CardId[] = [S0, S1, S2],
): { game: Game; received: Response[] } {
  const { registry, received } = probeRegistry(body)
  const game = buildGame(
    registry,
    { players: [{ general: PROBE_GENERAL, hand }, {}, {}], drawPileTop: [N0, N1] },
    options,
  )
  const r = game.start()
  expect(r.type).toBe('request')
  return { game, received }
}

// ───────────────────────────── 各种请求的脚本 ─────────────────────────────

/** play:0 号手牌 杀 / 闪 / 桃(满血,桃不可用),1 号存活,2 号已死亡;停在 0 号的 play 请求 */
function playGame(options: Partial<EngineOptions> = {}): { game: Game; request: PlayRequest } {
  const game = buildGame(
    BASE,
    {
      players: [{ hand: [S0, J0, P0] }, {}, { alive: false, hp: 0 }],
      drawPileTop: [N0, N1],
    },
    options,
  )
  game.start()
  const request = expectRequest(game, 'play')
  expect(request.player).toBe(0)
  return { game, request }
}

/** askCard(引擎路径):0 号对 1 号使用杀;1 号手牌 闪 / 杀 / 桃;停在 1 号的 askCard(闪)请求 */
function askJinkGame(options: Partial<EngineOptions> = {}): {
  game: Game
  request: AskCardRequest
} {
  const game = buildGame(
    BASE,
    { players: [{ hand: [S0] }, { hand: [J0, S1, P0] }, {}], drawPileTop: [N0, N1] },
    options,
  )
  game.start()
  expectRequest(game, 'play')
  answer(game, { action: 'useCard', card: S0, targets: [1] })
  const request = expectRequest(game, 'askCard')
  expect(request.player).toBe(1)
  return { game, request }
}

/** askCard(带 TargetSpec,借刀式):探针让 0 号使用一张杀并从 [1, 2] 中选恰好一个目标 */
const askWithTargets: ProbeBody = function* (ctx, owner, reason) {
  return yield* ask(ctx, {
    kind: 'askCard',
    player: owner,
    pattern: byName('slash'),
    mode: 'use',
    candidates: [S0],
    viewAsSkills: [],
    fixedTargets: [],
    targets: { candidates: [1, 2], min: 1, max: 1 },
    against: null,
    reason,
    prompt: { key: 'test.askCard', args: {} },
  })
}

/** chooseCards(引擎路径):0 号体力 2、手牌 2 张,摸牌后 4 张,弃牌阶段须弃 2 张;停在 chooseCards 请求 */
function discardGame(options: Partial<EngineOptions> = {}): {
  game: Game
  request: ChooseCardsRequest
} {
  const game = buildGame(
    BASE,
    { players: [{ hp: 2, hand: [S0, J0] }, {}], drawPileTop: [N0, N1] },
    options,
  )
  game.start()
  expectRequest(game, 'play')
  answer(game, { action: 'end' })
  const request = expectRequest(game, 'chooseCards')
  expect(request.player).toBe(0)
  expect(request.min).toBe(2)
  expect(request.max).toBe(2)
  expect(request.cancellable).toBe(false)
  expect(request.candidates.map((c) => c.index)).toStrictEqual([0, 1, 2, 3])
  return { game, request }
}

/** chooseCards(可取消):探针让 0 号从自己手牌中选 1 张,可取消 */
const chooseCancellable: ProbeBody = function* (ctx, owner, reason) {
  return yield* ask(ctx, {
    kind: 'chooseCards',
    player: owner,
    candidates: handCandidates(ctx, owner),
    min: 1,
    max: 1,
    cancellable: true,
    reason,
    prompt: { key: 'test.chooseCards', args: {} },
  })
}

/** chooseCards(盲位):探针让 0 号从 1 号的"手牌位"中盲选 1 张,候选不带 id 且 index 不连续 */
const chooseBlind: ProbeBody = function* (ctx, owner, reason) {
  return yield* ask(ctx, {
    kind: 'chooseCards',
    player: owner,
    candidates: [
      { index: 3, card: null, zone: { kind: 'hand', player: 1 } },
      { index: 7, card: null, zone: { kind: 'hand', player: 1 } },
    ],
    min: 1,
    max: 1,
    cancellable: false,
    reason,
    prompt: { key: 'test.chooseCards', args: {} },
  })
}

/** choosePlayers:探针让 0 号从 [1, 2] 中选 1~2 人 */
function choosePlayersBody(cancellable: boolean): ProbeBody {
  return function* (ctx, owner, reason) {
    return yield* ask(ctx, {
      kind: 'choosePlayers',
      player: owner,
      candidates: [1, 2],
      min: 1,
      max: 2,
      cancellable,
      reason,
      prompt: { key: 'test.choosePlayers', args: {} },
    })
  }
}

/** choice:探针让 0 号在 a / b 中选一个 */
const choiceBody: ProbeBody = function* (ctx, owner, reason) {
  return yield* ask(ctx, {
    kind: 'choice',
    player: owner,
    options: ['a', 'b'],
    cancellable: false,
    reason,
    prompt: { key: 'test.choice', args: {} },
  })
}

/** arrange:探针让 0 号把三张牌分到 top(1~2 张)/ bottom(0~3 张) */
const arrangeBody: ProbeBody = function* (ctx, owner, reason) {
  return yield* ask(ctx, {
    kind: 'arrange',
    player: owner,
    cards: [S0, S1, S2],
    slots: [
      { id: 'top', min: 1, max: 2 },
      { id: 'bottom', min: 0, max: 3 },
    ],
    reason,
    prompt: { key: 'test.arrange', args: {} },
  })
}

const OPT_GENERAL = 'validate_opt_general'
const OPT_SKILL = 'opt'

/** invokeSkill:0 号武将带一个 Turn.start 可选技;start 后停在"是否发动"的 invokeSkill 请求上 */
function invokeSkillGame(options: Partial<EngineOptions> = {}): {
  game: Game
  request: InvokeSkillRequest
  invoked: number[]
} {
  const invoked: number[] = []
  const opt: TriggerSkill<'Turn.start'> = {
    id: OPT_SKILL,
    name: '可选技',
    description: '回合开始时可发动,发动即记录',
    locked: false,
    lord: false,
    type: 'trigger',
    timings: ['Turn.start'],
    priority: 0,
    triggerWhenDead: false,
    canTrigger: () => true,
    *effect(_ctx, _ev, owner) {
      invoked.push(owner)
      yield* []
    },
  }
  const registry = createTestRegistry({
    name: 'validate-invoke',
    version: '0.0.0',
    skills: [opt],
    generals: [
      {
        id: OPT_GENERAL,
        name: '可选技武将',
        kingdom: 'wei',
        gender: 'male',
        maxHp: 4,
        skills: [OPT_SKILL],
      },
    ],
  })
  const game = buildGame(registry, { players: [{ general: OPT_GENERAL }, {}] }, options)
  game.start()
  const request = expectRequest(game, 'invokeSkill')
  expect(request.player).toBe(0)
  expect(request.skills).toStrictEqual([OPT_SKILL])
  return { game, request, invoked }
}

// ═════════════════════════════ 1. play ═════════════════════════════

describe('play 请求的校验', () => {
  it('候选集由引擎算好:只有杀可用,目标只有存活的他人', () => {
    const { request } = playGame()
    expect(request.usableCards).toStrictEqual([
      { card: S0, targets: { candidates: [1], min: 1, max: 1 } },
    ])
    expect(request.usableSkills).toStrictEqual([])
  })

  it('id 不匹配 / kind 不匹配 / 未知动作一律非法', () => {
    const { game, request } = playGame()
    expectRejected(game, raw(game, { action: 'end', requestId: request.id + 1 }), /requestId/)
    expectRejected(game, raw(game, { action: 'end', requestId: -1 }), /requestId/)
    expectRejected(
      game,
      raw(game, { kind: 'choice', option: 'a' }),
      /应答种类 choice 与请求 play 不符/,
    )
    expectRejected(game, raw(game, { action: 'discard' }), /未知的出牌动作/)
    expectRejected(game, raw(game, {}), /未知的出牌动作/)
  })

  it('useCard:牌不在可使用列表(闪不可主动使用、满血的桃、不在手牌的牌)', () => {
    const { game } = playGame()
    expectRejected(game, raw(game, { action: 'useCard', card: J0, targets: [1] }), /不在可使用列表/)
    expectRejected(game, raw(game, { action: 'useCard', card: P0, targets: [1] }), /不在可使用列表/)
    expectRejected(game, raw(game, { action: 'useCard', card: S1, targets: [1] }), /不在可使用列表/)
    expectRejected(
      game,
      raw(game, { action: 'useCard', card: NOT_A_CARD, targets: [1] }),
      /不在可使用列表/,
    )
  })

  it('useCard:目标不在候选(自己、已死亡者)、数量越界、重复、非整数数组', () => {
    const { game } = playGame()
    expectRejected(game, raw(game, { action: 'useCard', card: S0, targets: [0] }), /非候选项 0/)
    expectRejected(game, raw(game, { action: 'useCard', card: S0, targets: [2] }), /非候选项 2/)
    expectRejected(
      game,
      raw(game, { action: 'useCard', card: S0, targets: [] }),
      /数量 0 不在 \[1, 1\]/,
    )
    expectRejected(
      game,
      raw(game, { action: 'useCard', card: S0, targets: [1, 0] }),
      /数量 2 不在 \[1, 1\]/,
    )
    expectRejected(game, raw(game, { action: 'useCard', card: S0, targets: [1, 1] }), /重复/)
    expectRejected(game, raw(game, { action: 'useCard', card: S0, targets: ['1'] }), /整数数组/)
    expectRejected(game, raw(game, { action: 'useCard', card: S0 }), /整数数组/)
  })

  it('useSkill:技能不在可发动列表', () => {
    const { game } = playGame()
    expectRejected(
      game,
      raw(game, { action: 'useSkill', skill: 'wusheng', as: 'slash', cards: [S0], targets: [1] }),
      /不在可发动列表/,
    )
  })

  it('合法应答:useCard 杀 → 1 号(无闪)受到 1 点伤害后回到 play;end 结束出牌阶段', () => {
    const { game } = playGame()
    answer(game, { action: 'useCard', card: S0, targets: [1] })
    expect(expectRequest(game, 'play').player).toBe(0)
    expect(game.state.players[1]?.hp).toBe(3)
    expect(game.responses).toHaveLength(1)
    answer(game, { action: 'end' })
    // 手牌 4 张(闪、桃、两张锦囊)未超过上限 4,下一回合轮到 1 号
    expect(expectRequest(game, 'play').player).toBe(1)
  })
})

// ═════════════════════════════ 2. askCard ═════════════════════════════

describe('askCard 请求的校验(引擎路径:响应杀的闪)', () => {
  it('候选只含本人符合 pattern 的牌;无需选目标', () => {
    const { request } = askJinkGame()
    expect(request.candidates).toStrictEqual([J0])
    expect(request.viewAsSkills).toStrictEqual([])
    expect(request.fixedTargets).toStrictEqual([])
    expect(request.targets).toBeNull()
    expect(request.mode).toBe('use')
    expect(request.pattern.names).toStrictEqual(['jink'])
  })

  it('id 不匹配 / kind 不匹配', () => {
    const { game, request } = askJinkGame()
    expectRejected(
      game,
      raw(game, { card: J0, viewAs: null, targets: [], requestId: request.id - 1 }),
      /requestId/,
    )
    expectRejected(
      game,
      raw(game, { kind: 'play', action: 'end' }),
      /应答种类 play 与请求 askCard 不符/,
    )
  })

  it('牌不在候选(手里的杀 / 桃、不在手牌的牌、非整数)', () => {
    const { game } = askJinkGame()
    expectRejected(game, raw(game, { card: S1, viewAs: null, targets: [] }), /不在候选内/)
    expectRejected(game, raw(game, { card: P0, viewAs: null, targets: [] }), /不在候选内/)
    expectRejected(
      game,
      raw(game, { card: card('jink', 1), viewAs: null, targets: [] }),
      /不在候选内/,
    )
    expectRejected(game, raw(game, { card: 1.5, viewAs: null, targets: [] }), /不在候选内/)
  })

  it('card 与 viewAs 二选一;转化技不在候选', () => {
    const { game } = askJinkGame()
    expectRejected(
      game,
      raw(game, { card: J0, viewAs: { skill: 'longdan', cards: [S1] }, targets: [] }),
      /二选一/,
    )
    expectRejected(
      game,
      raw(game, { card: null, viewAs: { skill: 'longdan', cards: [S1] }, targets: [] }),
      /转化技不在候选内/,
    )
  })

  it('该询问不需要选目标时 targets 必须为空数组', () => {
    const { game } = askJinkGame()
    expectRejected(game, raw(game, { card: J0, viewAs: null, targets: [0] }), /不需要选择目标/)
    expectRejected(game, raw(game, { card: null, viewAs: null, targets: [0] }), /不需要选择目标/)
    expectRejected(game, raw(game, { card: J0, viewAs: null, targets: 'none' }), /必须是数组/)
    expectRejected(game, raw(game, { card: J0, viewAs: null }), /必须是数组/)
  })

  it('合法应答:出闪 → 不受伤害,闪进入弃牌堆;不响应 → 受到伤害', () => {
    const a = askJinkGame()
    answer(a.game, { card: J0, viewAs: null, targets: [] })
    expect(expectRequest(a.game, 'play').player).toBe(0)
    expect(a.game.state.players[1]?.hp).toBe(4)
    expect(a.game.state.players[1]?.hand).toStrictEqual([S1, P0])
    expect(a.game.state.discardPile).toContain(J0)

    const b = askJinkGame()
    answer(b.game, { card: null, viewAs: null, targets: [] })
    expect(expectRequest(b.game, 'play').player).toBe(0)
    expect(b.game.state.players[1]?.hp).toBe(3)
    expect(b.game.state.players[1]?.hand).toStrictEqual([J0, S1, P0])
  })
})

describe('askCard 请求的校验(带 TargetSpec:响应时选目标)', () => {
  it('响应时目标必须落在 TargetSpec 内且数量在范围内;不响应时不得带目标', () => {
    const { game } = probeGame(askWithTargets)
    const request = expectRequest(game, 'askCard')
    expect(request.targets).toStrictEqual({ candidates: [1, 2], min: 1, max: 1 })
    expectRejected(game, raw(game, { card: S0, viewAs: null, targets: [] }), /数量 0 不在 \[1, 1\]/)
    expectRejected(
      game,
      raw(game, { card: S0, viewAs: null, targets: [1, 2] }),
      /数量 2 不在 \[1, 1\]/,
    )
    expectRejected(game, raw(game, { card: S0, viewAs: null, targets: [0] }), /非候选项 0/)
    expectRejected(game, raw(game, { card: S0, viewAs: null, targets: [1, 1] }), /重复/)
    expectRejected(game, raw(game, { card: null, viewAs: null, targets: [1] }), /不需要选择目标/)
  })

  it('合法应答:牌 + 一个候选目标;或不响应 + 空目标', () => {
    const a = probeGame(askWithTargets)
    const ra = requirePending(a.game)
    answer(a.game, { card: S0, viewAs: null, targets: [2] })
    expectRequest(a.game, 'play')
    expect(a.received).toStrictEqual([
      { kind: 'askCard', requestId: ra.id, card: S0, viewAs: null, targets: [2] },
    ])

    const b = probeGame(askWithTargets)
    const rb = requirePending(b.game)
    answer(b.game, { card: null, viewAs: null, targets: [] })
    expectRequest(b.game, 'play')
    expect(b.received).toStrictEqual([
      { kind: 'askCard', requestId: rb.id, card: null, viewAs: null, targets: [] },
    ])
  })
})

// ═════════════════════════════ 3. chooseCards ═════════════════════════════

describe('chooseCards 请求的校验(引擎路径:弃牌阶段)', () => {
  it('id 不匹配 / kind 不匹配', () => {
    const { game, request } = discardGame()
    expectRejected(game, raw(game, { indices: [0, 1], requestId: request.id + 7 }), /requestId/)
    expectRejected(game, raw(game, { kind: 'choosePlayers', players: [0, 1] }), /应答种类/)
  })

  it('indices 越界 / 重复 / 数量不符 / 非整数数组;不可取消时空数组也非法', () => {
    const { game } = discardGame()
    expectRejected(game, raw(game, { indices: [0, 4] }), /非候选项 4/)
    expectRejected(game, raw(game, { indices: [0, -1] }), /非候选项 -1/)
    expectRejected(game, raw(game, { indices: [0, 0] }), /重复/)
    expectRejected(game, raw(game, { indices: [0] }), /数量 1 不在 \[2, 2\]/)
    expectRejected(game, raw(game, { indices: [0, 1, 2] }), /数量 3 不在 \[2, 2\]/)
    expectRejected(game, raw(game, { indices: [] }), /数量 0 不在 \[2, 2\]/)
    expectRejected(game, raw(game, { indices: [0, 1.5] }), /整数数组/)
    expectRejected(game, raw(game, { indices: ['0', 1] }), /整数数组/)
    expectRejected(game, raw(game, { indices: null }), /整数数组/)
    expectRejected(game, raw(game, {}), /整数数组/)
  })

  it('合法应答:按 index 弃掉对应的牌(顺序无关),之后轮到 1 号', () => {
    const { game, request } = discardGame()
    const hand = request.candidates.map((c) => c.card)
    answer(game, { indices: [3, 1] })
    expect(expectRequest(game, 'play').player).toBe(1)
    expect(game.state.players[0]?.hand).toStrictEqual([hand[0], hand[2]])
    expect(game.state.discardPile).toStrictEqual([hand[3], hand[1]])
  })
})

describe('chooseCards 请求的校验(可取消 / 盲位候选)', () => {
  it('可取消时空数组合法;非空仍须满足数量与候选', () => {
    const { game, received } = probeGame(chooseCancellable)
    const request = expectRequest(game, 'chooseCards')
    expect(request.cancellable).toBe(true)
    expect(request.candidates.map((c) => c.index)).toStrictEqual([0, 1, 2])
    expectRejected(game, raw(game, { indices: [0, 1] }), /数量 2 不在 \[1, 1\]/)
    expectRejected(game, raw(game, { indices: [3] }), /非候选项 3/)
    answer(game, { indices: [] })
    expectRequest(game, 'play')
    expect(received).toStrictEqual([{ kind: 'chooseCards', requestId: request.id, indices: [] }])
  })

  it('盲位候选:以不连续的 index 回传,不在候选的 index 非法', () => {
    const { game, received } = probeGame(chooseBlind)
    const request = expectRequest(game, 'chooseCards')
    expect(request.candidates.map((c) => c.card)).toStrictEqual([null, null])
    expectRejected(game, raw(game, { indices: [0] }), /非候选项 0/)
    expectRejected(game, raw(game, { indices: [] }), /数量 0 不在 \[1, 1\]/)
    answer(game, { indices: [7] })
    expectRequest(game, 'play')
    expect(received).toStrictEqual([{ kind: 'chooseCards', requestId: request.id, indices: [7] }])
  })
})

// ═════════════════════════════ 4. choosePlayers ═════════════════════════════

describe('choosePlayers 请求的校验', () => {
  it('id 不匹配 / kind 不匹配', () => {
    const { game } = probeGame(choosePlayersBody(false))
    const request = expectRequest(game, 'choosePlayers')
    expectRejected(game, raw(game, { players: [1], requestId: request.id + 1 }), /requestId/)
    expectRejected(game, raw(game, { kind: 'chooseCards', indices: [0] }), /应答种类/)
  })

  it('目标不在候选 / 数量越界 / 重复 / 非整数数组;不可取消时空数组非法', () => {
    const { game } = probeGame(choosePlayersBody(false))
    expectRejected(game, raw(game, { players: [0] }), /非候选项 0/)
    expectRejected(game, raw(game, { players: [1, 3] }), /非候选项 3/)
    expectRejected(game, raw(game, { players: [] }), /数量 0 不在 \[1, 2\]/)
    expectRejected(game, raw(game, { players: [1, 2, 0] }), /数量 3 不在 \[1, 2\]/)
    expectRejected(game, raw(game, { players: [1, 1] }), /重复/)
    expectRejected(game, raw(game, { players: ['1'] }), /整数数组/)
    expectRejected(game, raw(game, { players: 1 }), /整数数组/)
  })

  it('合法应答:1~2 个候选玩家(顺序保留)', () => {
    const { game, received } = probeGame(choosePlayersBody(false))
    const request = expectRequest(game, 'choosePlayers')
    answer(game, { players: [2, 1] })
    expectRequest(game, 'play')
    expect(received).toStrictEqual([
      { kind: 'choosePlayers', requestId: request.id, players: [2, 1] },
    ])
  })

  it('可取消时空数组合法', () => {
    const { game, received } = probeGame(choosePlayersBody(true))
    const request = expectRequest(game, 'choosePlayers')
    expect(request.cancellable).toBe(true)
    answer(game, { players: [] })
    expectRequest(game, 'play')
    expect(received).toStrictEqual([{ kind: 'choosePlayers', requestId: request.id, players: [] }])
  })
})

// ═════════════════════════════ 5. choice ═════════════════════════════

describe('choice 请求的校验', () => {
  it('option 不在列表 / id 不匹配 / kind 不匹配', () => {
    const { game } = probeGame(choiceBody)
    const request = expectRequest(game, 'choice')
    expect(request.options).toStrictEqual(['a', 'b'])
    expectRejected(game, raw(game, { option: 'c' }), /选项 c 不存在/)
    expectRejected(game, raw(game, { option: '' }), /选项 {2}不存在/)
    expectRejected(game, raw(game, { option: 0 }), /不存在/)
    expectRejected(game, raw(game, {}), /不存在/)
    expectRejected(game, raw(game, { option: 'a', requestId: request.id + 1 }), /requestId/)
    expectRejected(game, raw(game, { kind: 'invokeSkill', skill: null }), /应答种类/)
  })

  it('合法应答:列表中的任一选项', () => {
    const { game, received } = probeGame(choiceBody)
    const request = expectRequest(game, 'choice')
    answer(game, { option: 'b' })
    expectRequest(game, 'play')
    expect(received).toStrictEqual([{ kind: 'choice', requestId: request.id, option: 'b' }])
  })
})

// ═════════════════════════════ 6. invokeSkill ═════════════════════════════

describe('invokeSkill 请求的校验', () => {
  it('skill 不在列表 / id 不匹配 / kind 不匹配', () => {
    const { game, request, invoked } = invokeSkillGame()
    expectRejected(game, raw(game, { skill: 'nope' }), /技能 nope 不在候选内/)
    expectRejected(game, raw(game, { skill: '' }), /不在候选内/)
    expectRejected(game, raw(game, {}), /不在候选内/)
    expectRejected(game, raw(game, { skill: null, requestId: request.id + 1 }), /requestId/)
    expectRejected(game, raw(game, { kind: 'choice', option: OPT_SKILL }), /应答种类/)
    expect(invoked).toStrictEqual([])
  })

  it('合法应答:null 不发动;列表中的技能发动', () => {
    const a = invokeSkillGame()
    answer(a.game, { skill: null })
    expect(expectRequest(a.game, 'play').player).toBe(0)
    expect(a.invoked).toStrictEqual([])

    const b = invokeSkillGame()
    answer(b.game, { skill: OPT_SKILL })
    expect(expectRequest(b.game, 'play').player).toBe(0)
    expect(b.invoked).toStrictEqual([0])
  })
})

// ═════════════════════════════ 7. arrange ═════════════════════════════

describe('arrange 请求的校验', () => {
  it('id 不匹配 / kind 不匹配 / placement 不是对象', () => {
    const { game } = probeGame(arrangeBody)
    const request = expectRequest(game, 'arrange')
    expect(request.cards).toStrictEqual([S0, S1, S2])
    const valid = { top: [S0], bottom: [S1, S2] }
    expectRejected(game, raw(game, { placement: valid, requestId: request.id + 1 }), /requestId/)
    expectRejected(game, raw(game, { kind: 'choice', option: 'top' }), /应答种类/)
    expectRejected(game, raw(game, { placement: null }), /必须是对象/)
    expectRejected(game, raw(game, { placement: [S0, S1, S2] }), /必须是对象/)
    expectRejected(game, raw(game, { placement: 'top' }), /必须是对象/)
    expectRejected(game, raw(game, {}), /必须是对象/)
  })

  it('未全覆盖 / 重复 / 牌不在请求内 / 未知槽位 / 槽位数量越界 / 槽位不是整数数组', () => {
    const { game } = probeGame(arrangeBody)
    expectRejected(game, raw(game, { placement: { top: [S0] } }), /牌数与请求不一致/)
    expectRejected(game, raw(game, { placement: { top: [S0], bottom: [S1] } }), /牌数与请求不一致/)
    expectRejected(game, raw(game, { placement: { top: [S0], bottom: [S0, S1, S2] } }), /多个槽位/)
    expectRejected(game, raw(game, { placement: { top: [S0, S0], bottom: [S1] } }), /多个槽位/)
    expectRejected(game, raw(game, { placement: { top: [S0], bottom: [S1, J0] } }), /不在请求内/)
    expectRejected(
      game,
      raw(game, { placement: { top: [S0], bottom: [S1], mid: [S2] } }),
      /未知槽位 mid/,
    )
    expectRejected(
      game,
      raw(game, { placement: { top: [], bottom: [S0, S1, S2] } }),
      /槽位 top 数量 0 不在 \[1, 2\]/,
    )
    expectRejected(
      game,
      raw(game, { placement: { top: [S0, S1, S2], bottom: [] } }),
      /槽位 top 数量 3 不在 \[1, 2\]/,
    )
    expectRejected(game, raw(game, { placement: { top: S0, bottom: [S1, S2] } }), /整数数组/)
    expectRejected(game, raw(game, { placement: { top: ['0'], bottom: [S1, S2] } }), /整数数组/)
  })

  it('合法应答:每张牌恰好出现一次且各槽数量在范围内;min 为 0 的槽位可省略', () => {
    const a = probeGame(arrangeBody)
    const ra = requirePending(a.game)
    answer(a.game, { placement: { top: [S2, S0], bottom: [S1] } })
    expectRequest(a.game, 'play')
    expect(a.received).toStrictEqual([
      { kind: 'arrange', requestId: ra.id, placement: { top: [S2, S0], bottom: [S1] } },
    ])

    const b = probeGame(arrangeBody)
    const rb = requirePending(b.game)
    answer(b.game, { placement: { top: [S0, S1, S2].slice(0, 2), bottom: [S2] } })
    expectRequest(b.game, 'play')
    expect(b.received).toStrictEqual([
      { kind: 'arrange', requestId: rb.id, placement: { top: [S0, S1], bottom: [S2] } },
    ])
  })
})

// ═════════════════════════════ 8. 结构防御 ═════════════════════════════

describe('validateResponse 对非对象应答的防御', () => {
  it('字符串 / 数字 / undefined / 空对象一律判为非法而不抛错', () => {
    const { game, request } = playGame()
    const ctx = ctxOf(game)
    for (const bad of ['end', 1, undefined, {}]) {
      const verdict = validateResponse(ctx, request, bad as unknown as Response)
      expect(verdict.ok).toBe(false)
    }
  })

  it('null 应答判为非法而不是抛 TypeError(typeof null === "object")', () => {
    const { game, request } = playGame()
    const ctx = ctxOf(game)
    expect(validateResponse(ctx, request, null as unknown as Response).ok).toBe(false)
  })
})

// ═════════════════════════════ 9. invalidResponsePolicy = 'throw' ═════════════════════════════

describe("invalidResponsePolicy = 'throw'", () => {
  it('非法应答抛 InvalidResponseError(携带 reason),生成器不前进,pending / 状态 / 应答记录 / 日志全部不变', () => {
    const { game, request } = playGame({ invalidResponsePolicy: 'throw' })
    expect(game.options.invalidResponsePolicy).toBe('throw')
    const hash = game.stateHash()
    const logCount = game.log.length
    let caught: unknown = null
    try {
      game.step(raw(game, { action: 'useCard', card: J0, targets: [1] }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InvalidResponseError)
    if (caught instanceof InvalidResponseError) {
      expect(caught.reason).toMatch(/不在可使用列表/)
      expect(caught.message).toContain(caught.reason)
    }
    expect(game.pending).toBe(request)
    expect(game.stateHash()).toBe(hash)
    expect(game.responses).toStrictEqual([])
    expect(game.log).toHaveLength(logCount)
    expect(game.snapshot().responses).toStrictEqual([])
    expect(game.state.players[1]?.hp).toBe(4)
  })

  it('可连续多次重发同一 Request:对局未损坏,之后的合法应答正常推进', () => {
    const { game, request } = playGame({ invalidResponsePolicy: 'throw' })
    for (let i = 0; i < 3; i++) {
      expectRejected(game, raw(game, { action: 'useCard', card: S0, targets: [0] }))
      expect(game.pending?.id).toBe(request.id)
      expect(game.viewFor(0).waitingFor).toBe(0)
    }
    const r = answer(game, { action: 'useCard', card: S0, targets: [1] })
    expect(r.type).toBe('request')
    expect(game.state.players[1]?.hp).toBe(3)
    expect(game.responses).toStrictEqual([
      { kind: 'play', requestId: request.id, action: 'useCard', card: S0, targets: [1] },
    ])
    expect(game.log.filter((l) => l.type === 'invalidResponse')).toStrictEqual([])
  })

  it('非法应答不推进 nextRequestId:重发后的下一个请求 id 连续', () => {
    const { game, request } = askJinkGame({ invalidResponsePolicy: 'throw' })
    expectRejected(game, raw(game, { card: S1, viewAs: null, targets: [] }))
    answer(game, { card: null, viewAs: null, targets: [] })
    expect(expectRequest(game, 'play').id).toBe(request.id + 1)
  })
})

// ═════════════════════════════ 10. invalidResponsePolicy = 'default' ═════════════════════════════

describe("invalidResponsePolicy = 'default'", () => {
  it('play:非法应答被替换为 end 并记录为生效应答;写 invalidResponse 日志且出现在本步增量日志里', () => {
    const { game, request } = playGame({ invalidResponsePolicy: 'default' })
    const bad = raw(game, { action: 'useCard', card: J0, targets: [1] })
    const verdict = validateResponse(ctxOf(game), request, bad)
    expect(verdict.ok).toBe(false)
    const reason = verdict.ok ? '' : verdict.reason
    const r = game.step(bad)
    expect(r.type).toBe('request')
    // 替换后的应答 = defaultResponse(play) = end:出牌阶段结束,5 张手牌 > 上限 4 ⇒ 弃牌阶段
    expect(expectRequest(game, 'chooseCards').player).toBe(0)
    expect(game.state.players[1]?.hp).toBe(4)
    const expected = defaultResponse(request)
    expect(expected).toStrictEqual({ kind: 'play', requestId: request.id, action: 'end' })
    expect(game.responses).toStrictEqual([expected])
    const logged = game.log.filter((l) => l.type === 'invalidResponse')
    expect(logged).toStrictEqual([
      {
        seq: logged[0]?.seq,
        type: 'invalidResponse',
        data: { requestId: request.id, reason },
        visibleTo: null,
        eventId: null,
      },
    ])
    expect(r.logs[0]).toBe(logged[0])
  })

  it('askCard:非法应答落为"不响应",目标受到伤害;responses 里只有替换后的应答', () => {
    const { game, request } = askJinkGame({ invalidResponsePolicy: 'default' })
    const bad = raw(game, { card: S1, viewAs: null, targets: [] })
    const r = game.step(bad)
    expect(r.type).toBe('request')
    expect(expectRequest(game, 'play').player).toBe(0)
    expect(game.state.players[1]?.hp).toBe(3)
    expect(game.state.players[1]?.hand).toStrictEqual([J0, S1, P0])
    expect(game.responses).toHaveLength(2)
    expect(game.responses[1]).toStrictEqual(defaultResponse(request))
    expect(game.responses[1]).toStrictEqual({
      kind: 'askCard',
      requestId: request.id,
      card: null,
      viewAs: null,
      targets: [],
    })
    expect(game.responses).not.toContainEqual(bad)
    const logged = r.logs.filter((l) => l.type === 'invalidResponse')
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data).toStrictEqual({
      requestId: request.id,
      reason: `牌 ${S1} 不在候选内`,
    })
  })

  it('chooseCards:非法应答落为"按 index 取前 min 张",弃掉手牌前两张', () => {
    const { game, request } = discardGame({ invalidResponsePolicy: 'default' })
    const hand = request.candidates.map((c) => c.card)
    game.step(raw(game, { indices: [9, 9] }))
    expect(expectRequest(game, 'play').player).toBe(1)
    expect(game.responses[1]).toStrictEqual({
      kind: 'chooseCards',
      requestId: request.id,
      indices: [0, 1],
    })
    expect(game.state.players[0]?.hand).toStrictEqual([hand[2], hand[3]])
    expect(game.state.discardPile).toStrictEqual([hand[0], hand[1]])
  })

  it('invokeSkill:非法应答落为"不发动"', () => {
    const { game, request, invoked } = invokeSkillGame({ invalidResponsePolicy: 'default' })
    game.step(raw(game, { skill: 'nope' }))
    expect(expectRequest(game, 'play').player).toBe(0)
    expect(invoked).toStrictEqual([])
    expect(game.responses).toStrictEqual([
      { kind: 'invokeSkill', requestId: request.id, skill: null },
    ])
  })

  it('探针请求(choice / choosePlayers / arrange):生成器收到的正是 defaultResponse', () => {
    const cases: Array<{ body: ProbeBody; bad: Record<string, unknown> }> = [
      { body: choiceBody, bad: { option: 'zzz' } },
      { body: choosePlayersBody(false), bad: { players: [0] } },
      { body: arrangeBody, bad: { placement: { top: [S0] } } },
    ]
    for (const { body, bad } of cases) {
      const { game, received } = probeGame(body, { invalidResponsePolicy: 'default' })
      const request = requirePending(game)
      game.step(raw(game, bad))
      expectRequest(game, 'play')
      expect(received).toStrictEqual([defaultResponse(request)])
      expect(game.responses).toStrictEqual([defaultResponse(request)])
      expect(game.log.filter((l) => l.type === 'invalidResponse')).toHaveLength(1)
    }
  })

  it('合法应答不被替换、不写 invalidResponse 日志', () => {
    const { game, request } = askJinkGame({ invalidResponsePolicy: 'default' })
    const good: Response = {
      kind: 'askCard',
      requestId: request.id,
      card: J0,
      viewAs: null,
      targets: [],
    }
    const r = game.step(good)
    expect(r.logs.filter((l) => l.type === 'invalidResponse')).toStrictEqual([])
    expect(game.responses[1]).toStrictEqual(good)
    expect(game.state.players[1]?.hp).toBe(4)
  })

  it('回放只认生效应答:含非法应答的对局 snapshot → restore 后状态哈希一致', () => {
    const { game } = askJinkGame({ invalidResponsePolicy: 'default' })
    game.step(raw(game, { card: P0, viewAs: null, targets: [] }))
    expectRequest(game, 'play')
    game.step(raw(game, { action: 'useCard', card: NOT_A_CARD, targets: [1] }))
    expectRequest(game, 'play')
    expect(game.log.filter((l) => l.type === 'invalidResponse')).toHaveLength(2)
    // 回合边界快照 + 本回合应答(夹具状态不可由 config 重建,只能走 base 路径)
    const snapshot = game.snapshot()
    expect(snapshot.base).not.toBeNull()
    const restored = Game.restore(snapshot, BASE)
    expect(restored.stateHash()).toBe(game.stateHash())
    expect(restored.pending).toStrictEqual(game.pending)
  })

  it('全量回放(base = null)只喂入生效应答:从 config 开局的对局含非法应答时回放哈希一致', () => {
    const config = {
      seed: 20_260_101,
      mode: 'ffa',
      players: [{ general: null }, { general: null }, { general: null }],
      fixedDeckOrder: null,
      options: { ...TEST_OPTIONS, invalidResponsePolicy: 'default' as const },
    }
    const game = new Game(config, BASE)
    game.start()
    // 连续三步都给非法应答:每步都被替换为该请求的 defaultResponse
    const originals: Response[] = []
    for (let i = 0; i < 3; i++) {
      const pending = requirePending(game)
      const bad = raw(game, { requestId: pending.id + 1_000 })
      originals.push(bad)
      const r = game.step(bad)
      expect(r.type).toBe('request')
    }
    expect(game.responses).toHaveLength(3)
    for (const bad of originals) expect(game.responses).not.toContainEqual(bad)
    expect(game.log.filter((l) => l.type === 'invalidResponse')).toHaveLength(3)
    const full = { ...game.snapshot(), base: null, responses: [...game.responses], log: [] }
    const replayed = Game.restore(full, BASE)
    expect(replayed.stateHash()).toBe(game.stateHash())
    expect(replayed.pending).toStrictEqual(game.pending)
    expect(replayed.responses).toStrictEqual(game.responses)
    // 用回合边界快照恢复亦一致
    const resumed = Game.restore(game.snapshot(), BASE)
    expect(resumed.stateHash()).toBe(game.stateHash())
  })
})

// ═════════════════════════════ 11. defaultResponse 的确定值 ═════════════════════════════

describe('defaultResponse 对每种 kind 的确定值(且恒为合法应答)', () => {
  const prompt = { key: 'test', args: {} }

  /** 断言默认应答等于期望值,且能通过 validateResponse */
  function expectDefault(ctx: Ctx, request: Request, expected: Response): void {
    const actual = defaultResponse(request)
    expect(actual).toStrictEqual(expected)
    expect(defaultResponse(request)).toStrictEqual(actual)
    expect(validateResponse(ctx, request, actual)).toStrictEqual({ ok: true })
  }

  it('play → end', () => {
    const { game, request } = playGame()
    expectDefault(ctxOf(game), request, { kind: 'play', requestId: request.id, action: 'end' })
  })

  it('askCard → 不响应(card / viewAs 为 null、targets 为空),无论是否需要选目标', () => {
    const a = askJinkGame()
    expectDefault(ctxOf(a.game), a.request, {
      kind: 'askCard',
      requestId: a.request.id,
      card: null,
      viewAs: null,
      targets: [],
    })
    const b = probeGame(askWithTargets)
    const rb = expectRequest(b.game, 'askCard')
    expectDefault(ctxOf(b.game), rb, {
      kind: 'askCard',
      requestId: rb.id,
      card: null,
      viewAs: null,
      targets: [],
    })
  })

  it('chooseCards → 按候选顺序取前 min 项的 index(盲位 / 不连续 index 同样成立;min = 0 则空)', () => {
    const { game } = playGame()
    const ctx = ctxOf(game)
    const base: Omit<ChooseCardsRequest, 'candidates' | 'min' | 'max' | 'cancellable'> = {
      kind: 'chooseCards',
      id: 99,
      player: 0,
      prompt,
      reason: null,
    }
    const own: ChooseCardsRequest = {
      ...base,
      candidates: handCandidates(ctx, 0),
      min: 2,
      max: 3,
      cancellable: false,
    }
    expectDefault(ctx, own, { kind: 'chooseCards', requestId: 99, indices: [0, 1] })
    const blind: ChooseCardsRequest = {
      ...base,
      candidates: [
        { index: 5, card: null, zone: { kind: 'hand', player: 1 } },
        { index: 2, card: null, zone: { kind: 'hand', player: 1 } },
        { index: 9, card: null, zone: { kind: 'hand', player: 1 } },
      ],
      min: 2,
      max: 2,
      cancellable: false,
    }
    expectDefault(ctx, blind, { kind: 'chooseCards', requestId: 99, indices: [5, 2] })
    const optional: ChooseCardsRequest = { ...own, min: 0, max: 1, cancellable: true }
    expectDefault(ctx, optional, { kind: 'chooseCards', requestId: 99, indices: [] })
  })

  it('choosePlayers → 候选顺序的前 min 个', () => {
    const { game } = playGame()
    const ctx = ctxOf(game)
    const request: ChoosePlayersRequest = {
      kind: 'choosePlayers',
      id: 5,
      player: 0,
      prompt,
      reason: null,
      candidates: [2, 1],
      min: 1,
      max: 2,
      cancellable: false,
    }
    expectDefault(ctx, request, { kind: 'choosePlayers', requestId: 5, players: [2] })
    expectDefault(
      ctx,
      { ...request, min: 0, cancellable: true },
      { kind: 'choosePlayers', requestId: 5, players: [] },
    )
  })

  it('choice → options[0]', () => {
    const { game } = playGame()
    const request: ChoiceRequest = {
      kind: 'choice',
      id: 3,
      player: 1,
      prompt,
      reason: null,
      options: ['keep', 'discard'],
      cancellable: false,
    }
    expectDefault(ctxOf(game), request, { kind: 'choice', requestId: 3, option: 'keep' })
  })

  it('invokeSkill → null(不发动),即使只有一个技能', () => {
    const { game, request } = invokeSkillGame()
    expectDefault(ctxOf(game), request, { kind: 'invokeSkill', requestId: request.id, skill: null })
  })

  it('arrange → 按顺序填满各槽的 min,余下的牌再按槽序补到 max:全部牌恰好出现一次', () => {
    const { game } = playGame()
    const ctx = ctxOf(game)
    const request: ArrangeRequest = {
      kind: 'arrange',
      id: 8,
      player: 0,
      prompt,
      reason: null,
      cards: [S0, S1, S2, J0],
      slots: [
        { id: 'top', min: 1, max: 2 },
        { id: 'bottom', min: 1, max: 3 },
      ],
    }
    expectDefault(ctx, request, {
      kind: 'arrange',
      requestId: 8,
      placement: { top: [S0, S2], bottom: [S1, J0] },
    })
    // 各槽 min 之和恰等于牌数:只按 min 填
    expectDefault(
      ctx,
      {
        ...request,
        cards: [S0, S1, S2],
        slots: [
          { id: 'top', min: 1, max: 1 },
          { id: 'bottom', min: 2, max: 2 },
        ],
      },
      { kind: 'arrange', requestId: 8, placement: { top: [S0], bottom: [S1, S2] } },
    )
    // 全部 min 为 0:余牌按槽序补到 max
    expectDefault(
      ctx,
      {
        ...request,
        cards: [S0, S1, S2],
        slots: [
          { id: 'top', min: 0, max: 1 },
          { id: 'bottom', min: 0, max: 3 },
        ],
      },
      { kind: 'arrange', requestId: 8, placement: { top: [S0], bottom: [S1, S2] } },
    )
  })

  it('引擎实际发出的每种请求,其 defaultResponse 都能通过校验', () => {
    const requests: Array<{ game: Game; request: Request }> = [
      playGame(),
      askJinkGame(),
      discardGame(),
      invokeSkillGame(),
    ]
    for (const body of [
      askWithTargets,
      chooseCancellable,
      chooseBlind,
      choosePlayersBody(false),
      choiceBody,
      arrangeBody,
    ]) {
      const { game } = probeGame(body)
      requests.push({ game, request: requirePending(game) })
    }
    for (const { game, request } of requests) {
      expect(validateResponse(ctxOf(game), request, defaultResponse(request))).toStrictEqual({
        ok: true,
      })
      const r = game.step(defaultResponse(request))
      expect(r.type).toBe('request')
    }
  })
})

// ═════════════════════════════ 12. 候选集与校验共用同一真相 ═════════════════════════════

describe('候选集与校验共用同一真相', () => {
  it('play 请求列出的每张可用牌,对其候选目标的任一合法组合都通过校验;目标不足则不出现在列表里', () => {
    const game = buildGame(BASE, {
      players: threePlayers({ hand: [S0, S1, P0], hp: 3 }),
      drawPileTop: [N0, N1],
    })
    game.start()
    const request = expectRequest(game, 'play')
    const ctx = ctxOf(game)
    // 杀:目标 1 / 2 都合法;桃(hp 3 < 4):无需目标
    expect(request.usableCards.map((u) => u.card)).toStrictEqual([S0, S1, P0])
    for (const usable of request.usableCards) {
      const targets = usable.targets.min === 0 ? [[]] : usable.targets.candidates.map((t) => [t])
      for (const t of targets) {
        const response: Response = {
          kind: 'play',
          requestId: request.id,
          action: 'useCard',
          card: usable.card,
          targets: t,
        }
        expect(validateResponse(ctx, request, response)).toStrictEqual({ ok: true })
      }
    }
    expect(
      validateResponse(ctx, request, {
        kind: 'play',
        requestId: request.id,
        action: 'useCard',
        card: P0,
        targets: [0],
      }),
    ).toStrictEqual({ ok: false, reason: '目标 数量 1 不在 [0, 0] 内' })
  })
})
