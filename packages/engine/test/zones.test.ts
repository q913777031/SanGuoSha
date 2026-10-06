/**
 * zones.test.ts ─ core/zones.ts 的区域与牌堆测试:
 * moveCards 原子性与 from / visibleTo 推导、position top / bottom、装备槽 / 判定区移动、
 * 总牌数不变量能捕获篡改、ensureDrawPile 洗回(保持顶牌顺序)、两堆皆空判平局、
 * reorderDrawPile 不触发 CardsMove、peekDrawPile 不移动。
 *
 * 驱动方式:全部同步脚本式(Game.start / step)。需要引擎上下文的用例通过"探针技能"执行:
 * 0 号玩家的武将带一个 Turn.start 锁定技,发动时执行测试体,然后发出一个 choice 请求暂停,
 * 使 game.start() 恰停在测试体执行完毕的状态上供断言。
 */
import { describe, expect, it } from 'vitest'

import type {
  CardDef,
  CardId,
  CardsMoveEvent,
  ContentPackage,
  Ctx,
  EquipSlot,
  Flow,
  Game,
  LogEntry,
  PlayerId,
  Registry,
  TriggerSkill,
} from '../src/index.js'
import {
  EngineBrokenError,
  EngineError,
  allCardsOf,
  ask,
  assertCardInvariant,
  createStandardRegistry,
  drawFromPile,
  ensureDrawPile,
  moveCards,
  moveVisibility,
  peekDrawPile,
  reorderDrawPile,
  shuffleInPlace,
  zoneOf,
} from '../src/index.js'
import type { StateSpec } from '../src/testing/index.js'
import { answer, buildGame, createTestRegistry, expectRequest } from '../src/testing/index.js'

// ───────────────────────────── 牌 id 查询 ─────────────────────────────

/** 只用于按牌名查 id 的基准注册表(牌表与测试注册表一致) */
const BASE: Registry = createStandardRegistry()

/** 全部牌 id(升序) */
function allCards(): CardId[] {
  return BASE.deck.map((s) => s.id)
}

/** 牌表中第 index 张名为 name 的牌 */
function card(name: string, index: number): CardId {
  const found = BASE.deck.filter((s) => s.name === name).map((s) => s.id)
  const id = found[index]
  if (id === undefined) throw new Error(`牌表中没有第 ${index} 张 ${name}`)
  return id
}

const S0 = card('slash', 0)
const S1 = card('slash', 1)
const S2 = card('slash', 2)
const S3 = card('slash', 3)
const S4 = card('slash', 4)
const J0 = card('jink', 0)
const J1 = card('jink', 1)
const J2 = card('jink', 2)
const P0 = card('peach', 0)
const P1 = card('peach', 1)
const P2 = card('peach', 2)
const P3 = card('peach', 3)
const P4 = card('peach', 4)
const P5 = card('peach', 5)
const CROSSBOW = card('crossbow', 0)
const QINGGANG = card('qinggang_sword', 0)
const DILU = card('dilu', 0)
const EIGHT_DIAGRAM = card('eight_diagram', 0)
const INDULGENCE0 = card('indulgence', 0)
const INDULGENCE1 = card('indulgence', 1)

// ───────────────────────────── 探针夹具 ─────────────────────────────

const PROBE_GENERAL = 'zones_probe_general'
const PROBE_SKILL = 'zones_probe'
const PAUSE_OPTION = 'pause'

/** 探针体:在 0 号玩家的 Turn.start 时机以引擎上下文执行 */
type ProbeBody = (ctx: Ctx, owner: PlayerId) => Flow<void>

/** 什么都不做的探针体 */
function* noop(): Flow<void> {
  yield* []
}

/** 测试用装备牌定义(M1 未注册装备,这里补最小定义以便进入装备区) */
function equipCard(
  name: string,
  slot: EquipSlot,
  range: number | null,
  distance: number | null,
): CardDef {
  return {
    name,
    type: 'equip',
    equip: { slot, range, distance, skills: [] },
    judgePattern: null,
    nullifiable: false,
    target: { min: 0, max: 0, auto: 'self', range: null, excludeSelf: false },
    canUse: () => false,
  }
}

/** 构造含探针技能、测试装备牌与额外技能的内容包 */
function probePackage(body: ProbeBody, extraSkills: readonly TriggerSkill[]): ContentPackage {
  const probe: TriggerSkill<'Turn.start'> = {
    id: PROBE_SKILL,
    name: '探针',
    description: '回合开始时执行测试体,然后以 choice 请求暂停',
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
      yield* body(ctx, owner)
      yield* ask(ctx, {
        kind: 'choice',
        player: owner,
        options: [PAUSE_OPTION],
        cancellable: false,
        reason: ev.id,
        prompt: { key: 'test.pause', args: {} },
      })
    },
  }
  return {
    name: 'zones-test',
    version: '0.0.0',
    cards: [
      equipCard('crossbow', 'weapon', 1, null),
      equipCard('qinggang_sword', 'weapon', 2, null),
      equipCard('dilu', 'horse_defensive', null, 1),
    ],
    skills: [probe, ...extraSkills],
    generals: [
      {
        id: PROBE_GENERAL,
        name: '探针武将',
        kingdom: 'wei',
        gender: 'male',
        maxHp: 4,
        skills: [PROBE_SKILL, ...extraSkills.map((s) => s.id)],
      },
    ],
  }
}

/** 构造带探针的对局(未 start):0 号玩家持探针武将 */
function probeGame(
  spec: StateSpec,
  body: ProbeBody,
  extraSkills: readonly TriggerSkill[] = [],
): { game: Game; registry: Registry } {
  const registry = createTestRegistry(probePackage(body, extraSkills))
  const players = spec.players.map((p, i) => (i === 0 ? { ...p, general: PROBE_GENERAL } : p))
  const game = buildGame(registry, { ...spec, players })
  return { game, registry }
}

/** start 并断言停在探针的暂停请求上 */
function runProbe(
  spec: StateSpec,
  body: ProbeBody,
  extraSkills: readonly TriggerSkill[] = [],
): { game: Game; registry: Registry } {
  const h = probeGame(spec, body, extraSkills)
  const r = h.game.start()
  expect(r.type).toBe('request')
  const pending = expectRequest(h.game, 'choice')
  expect(pending.options).toEqual([PAUSE_OPTION])
  return h
}

/** 把 spec 未用到的全部牌放进指定玩家手牌,使牌堆 / 弃牌堆恰为 spec 所述 */
function withExactPiles(spec: StateSpec, holder = 0): StateSpec {
  const used = new Set<CardId>()
  for (const p of spec.players) {
    for (const c of p.hand ?? []) used.add(c)
    for (const c of p.judgeArea ?? []) used.add(c)
    for (const c of Object.values(p.equips ?? {})) used.add(c)
  }
  for (const c of spec.drawPileTop ?? []) used.add(c)
  for (const c of spec.discardPile ?? []) used.add(c)
  const rest = allCards().filter((c) => !used.has(c))
  const players = spec.players.map((p, i) =>
    i === holder ? { ...p, hand: [...(p.hand ?? []), ...rest] } : p,
  )
  return { ...spec, players }
}

/** 记录全部 CardsMove.after 事件的锁定技(只在未被取消的移动后触发) */
function captureMoves(): { skill: TriggerSkill; events: CardsMoveEvent[] } {
  const events: CardsMoveEvent[] = []
  const skill: TriggerSkill<'CardsMove.after'> = {
    id: 'zones_capture',
    name: '记录移动',
    description: '记录每个 CardsMove 事件',
    locked: true,
    lord: false,
    type: 'trigger',
    timings: ['CardsMove.after'],
    priority: 0,
    triggerWhenDead: true,
    canTrigger: () => true,
    *effect(_ctx, ev) {
      events.push(ev)
      yield* []
    },
  }
  return { skill, events }
}

/** 某事件的 cardsMove / cardsMoveHidden 日志 */
function moveLogs(game: Game, eventId: number): LogEntry[] {
  return game.log.filter(
    (e) => e.eventId === eventId && (e.type === 'cardsMove' || e.type === 'cardsMoveHidden'),
  )
}

/** 日志条目里的 moves 数组(纯数据) */
function logMoves(entry: LogEntry): Array<Record<string, unknown>> {
  const data = entry.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('cardsMove 日志 data 应为对象')
  }
  const moves = data['moves']
  if (!Array.isArray(moves)) throw new Error('cardsMove 日志缺少 moves')
  return moves.map((m) => {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) throw new Error('move 应为对象')
    return m
  })
}

// ───────────────────────────── 用例 ─────────────────────────────

describe('moveVisibility:from / visibleTo 推导', () => {
  it('牌堆 ↔ 手牌仅 owner 可见', () => {
    expect(moveVisibility({ kind: 'draw' }, { kind: 'hand', player: 2 })).toEqual([2])
    expect(moveVisibility({ kind: 'hand', player: 1 }, { kind: 'draw' })).toEqual([1])
  })

  it('手牌 → 手牌双方可见;自己给自己只有本人', () => {
    expect(moveVisibility({ kind: 'hand', player: 0 }, { kind: 'hand', player: 3 })).toEqual([0, 3])
    expect(moveVisibility({ kind: 'hand', player: 2 }, { kind: 'hand', player: 2 })).toEqual([2])
  })

  it('进入牌堆的其他移动(弃牌堆洗回)对所有人隐藏,只公开数量', () => {
    expect(moveVisibility({ kind: 'discard' }, { kind: 'draw' })).toEqual([])
    expect(moveVisibility({ kind: 'processing' }, { kind: 'draw' })).toEqual([])
  })

  it('其余移动公开(null)', () => {
    expect(moveVisibility({ kind: 'hand', player: 0 }, { kind: 'discard' })).toBeNull()
    expect(moveVisibility({ kind: 'draw' }, { kind: 'processing' })).toBeNull()
    expect(moveVisibility({ kind: 'hand', player: 0 }, { kind: 'equip', player: 0 })).toBeNull()
    expect(moveVisibility({ kind: 'hand', player: 0 }, { kind: 'judge', player: 1 })).toBeNull()
    expect(moveVisibility({ kind: 'equip', player: 1 }, { kind: 'discard' })).toBeNull()
    expect(moveVisibility({ kind: 'discard' }, { kind: 'hand', player: 1 })).toBeNull()
  })
})

describe('moveCards:原子移动、from / visibleTo 推导与日志分组', () => {
  it('一条 CardsMove 内跨区域的多条移动全部成功,只产生一个事件', () => {
    let captured: CardsMoveEvent | null = null
    let eventIdBefore = -1
    const { game } = runProbe(
      {
        players: [{ hand: [S0, S1, J0] }, { hand: [P0] }],
        drawPileTop: [S2, S3],
        discardPile: [J1],
      },
      function* (ctx) {
        eventIdBefore = ctx.state.nextEventId
        captured = yield* moveCards(ctx, [
          { card: S0, to: { kind: 'discard' }, reason: 'discard' },
          { card: S2, to: { kind: 'hand', player: 0 }, reason: 'draw' },
          { card: J0, to: { kind: 'hand', player: 1 }, reason: 'give' },
          { card: J1, to: { kind: 'processing' }, reason: 'skill' },
        ])
      },
    )
    const ev = captured as CardsMoveEvent | null
    if (ev === null) throw new Error('探针未执行')
    expect(ev.kind).toBe('CardsMove')
    expect(ev.cancelled).toBe(false)
    expect(ev.id).toBe(eventIdBefore)
    expect(game.state.nextEventId).toBe(eventIdBefore + 1)

    const s = game.state
    expect(s.players[0]?.hand).toEqual([S1, S2])
    expect(s.players[1]?.hand).toEqual([P0, J0])
    expect(s.discardPile).toEqual([S0])
    expect(s.processing).toEqual([J1])
    expect(s.drawPile[s.drawPile.length - 1]).toBe(S3)
    expect(s.stack.map((e) => e.kind)).toEqual(['Turn'])

    expect(ev.moves).toHaveLength(4)
    expect(ev.moves[0]).toEqual({
      card: S0,
      from: { kind: 'hand', player: 0 },
      to: { kind: 'discard' },
      reason: 'discard',
      position: 'top',
      visibleTo: null,
      as: null,
    })
    expect(ev.moves[1]?.from).toEqual({ kind: 'draw' })
    expect(ev.moves[1]?.visibleTo).toEqual([0])
    expect(ev.moves[2]?.from).toEqual({ kind: 'hand', player: 0 })
    expect(ev.moves[2]?.visibleTo).toEqual([0, 1])
    expect(ev.moves[3]?.from).toEqual({ kind: 'discard' })
    expect(ev.moves[3]?.visibleTo).toBeNull()
  })

  it('日志按可见性分组:公开组一条,私有组各一条,并给其他人只含数量的隐藏条目', () => {
    let captured: CardsMoveEvent | null = null
    const { game } = runProbe(
      {
        players: [{ hand: [S0, J0] }, { hand: [P0] }, {}],
        drawPileTop: [S2],
        discardPile: [J1],
      },
      function* (ctx) {
        captured = yield* moveCards(ctx, [
          { card: S0, to: { kind: 'discard' }, reason: 'discard' },
          { card: S2, to: { kind: 'hand', player: 0 }, reason: 'draw' },
          { card: J0, to: { kind: 'hand', player: 1 }, reason: 'give' },
          { card: J1, to: { kind: 'processing' }, reason: 'skill' },
        ])
      },
    )
    const ev = captured as CardsMoveEvent | null
    if (ev === null) throw new Error('探针未执行')
    const logs = moveLogs(game, ev.id)
    const visible = logs.filter((e) => e.type === 'cardsMove')
    const hidden = logs.filter((e) => e.type === 'cardsMoveHidden')
    expect(visible).toHaveLength(3)
    expect(hidden).toHaveLength(2)

    const publicGroup = visible.find((e) => e.visibleTo === null)
    const ownerGroup = visible.find((e) => JSON.stringify(e.visibleTo) === '[0]')
    const pairGroup = visible.find((e) => JSON.stringify(e.visibleTo) === '[0,1]')
    if (!publicGroup || !ownerGroup || !pairGroup) throw new Error('缺少可见性分组')
    expect(logMoves(publicGroup).map((m) => m['card'])).toEqual([S0, J1])
    expect(logMoves(ownerGroup).map((m) => m['card'])).toEqual([S2])
    expect(logMoves(pairGroup).map((m) => m['card'])).toEqual([J0])

    // 隐藏条目发给不在 visibleTo 内的玩家,且不含牌 id
    const hiddenFor = hidden.map((e) => JSON.stringify(e.visibleTo)).sort()
    expect(hiddenFor).toEqual(['[1,2]', '[2]'])
    for (const e of hidden) {
      for (const m of logMoves(e)) {
        expect(m).not.toHaveProperty('card')
        expect(m).toHaveProperty('from')
        expect(m).toHaveProperty('to')
      }
    }
  })

  it('同一条 CardsMove 中同一张牌出现两次抛 EngineError', () => {
    const { game } = probeGame({ players: [{ hand: [S0] }, {}] }, function* (ctx) {
      yield* moveCards(ctx, [
        { card: S0, to: { kind: 'discard' }, reason: 'discard' },
        { card: S0, to: { kind: 'processing' }, reason: 'skill' },
      ])
    })
    expect(() => game.start()).toThrow(EngineError)
  })

  it('CardsMove.before 被取消后任何牌都不移动,事件 cancelled 为 true 且不写移动日志', () => {
    const cancelGive: TriggerSkill<'CardsMove.before'> = {
      id: 'zones_cancel_give',
      name: '拒绝赠予',
      description: '取消所有 reason 为 give 的移动',
      locked: true,
      lord: false,
      type: 'trigger',
      timings: ['CardsMove.before'],
      priority: 0,
      triggerWhenDead: false,
      canTrigger(_ctx, ev) {
        return ev.moves.every((m) => m.reason === 'give')
      },
      *effect(_ctx, ev) {
        ev.cancelled = true
        yield* []
      },
    }
    let captured: CardsMoveEvent | null = null
    const { game } = runProbe(
      { players: [{ hand: [S0, S1] }, { hand: [P0] }] },
      function* (ctx) {
        captured = yield* moveCards(ctx, [
          { card: S0, to: { kind: 'hand', player: 1 }, reason: 'give' },
          { card: S1, to: { kind: 'hand', player: 1 }, reason: 'give' },
        ])
      },
      [cancelGive],
    )
    const ev = captured as CardsMoveEvent | null
    if (ev === null) throw new Error('探针未执行')
    expect(ev.cancelled).toBe(true)
    expect(game.state.players[0]?.hand).toEqual([S0, S1])
    expect(game.state.players[1]?.hand).toEqual([P0])
    expect(moveLogs(game, ev.id)).toEqual([])
    expect(() => assertCardInvariant({ state: game.state, registry: game.registry })).not.toThrow()
  })

  it('from / visibleTo 以原子应用时的实际区域为准(CardsMove.before 中被转移的牌)', () => {
    const relay: TriggerSkill<'CardsMove.before'> = {
      id: 'zones_relay',
      name: '转移',
      description: 'reason 为 skill 的移动生效前,先把牌给 1 号玩家',
      locked: true,
      lord: false,
      type: 'trigger',
      timings: ['CardsMove.before'],
      priority: 0,
      triggerWhenDead: false,
      canTrigger(_ctx, ev) {
        return ev.moves.every((m) => m.reason === 'skill')
      },
      *effect(ctx, ev) {
        yield* moveCards(
          ctx,
          ev.moves.map((m) => ({
            card: m.card,
            to: { kind: 'hand' as const, player: 1 },
            reason: 'give' as const,
          })),
        )
      },
    }
    let captured: CardsMoveEvent | null = null
    const { game } = runProbe(
      { players: [{ hand: [S0] }, {}] },
      function* (ctx) {
        captured = yield* moveCards(ctx, [{ card: S0, to: { kind: 'discard' }, reason: 'skill' }])
      },
      [relay],
    )
    const ev = captured as CardsMoveEvent | null
    if (ev === null) throw new Error('探针未执行')
    expect(ev.cancelled).toBe(false)
    expect(ev.moves[0]?.from).toEqual({ kind: 'hand', player: 1 })
    expect(ev.moves[0]?.visibleTo).toBeNull()
    expect(game.state.discardPile).toEqual([S0])
    expect(game.state.players[0]?.hand).toEqual([])
    expect(game.state.players[1]?.hand).toEqual([])
    const visible = moveLogs(game, ev.id).filter((e) => e.type === 'cardsMove')
    expect(visible).toHaveLength(1)
    expect(logMoves(visible[0] as LogEntry)[0]?.['from']).toEqual({ kind: 'hand', player: 1 })
  })

  it('position:bottom 放到牌堆底、top(缺省)放到牌堆顶;对手牌等区域总是追加到末尾', () => {
    let captured: CardsMoveEvent | null = null
    const { game } = runProbe(
      withExactPiles(
        { players: [{ hand: [S0, S1, S2] }, { hand: [P0] }], drawPileTop: [J0, J1] },
        1,
      ),
      function* (ctx) {
        captured = yield* moveCards(ctx, [
          { card: S0, to: { kind: 'draw' }, reason: 'skill', position: 'bottom' },
          { card: S1, to: { kind: 'draw' }, reason: 'skill' },
          { card: S2, to: { kind: 'hand', player: 1 }, reason: 'give', position: 'bottom' },
        ])
      },
    )
    const ev = captured as CardsMoveEvent | null
    if (ev === null) throw new Error('探针未执行')
    const s = game.state
    // 牌堆:末尾 = 顶。原牌堆只有 [J1, J0](J0 顶)
    expect(s.drawPile).toEqual([S0, J1, J0, S1])
    expect(ev.moves[0]?.position).toBe('bottom')
    expect(ev.moves[1]?.position).toBe('top')
    expect(ev.moves[0]?.visibleTo).toEqual([0])
    expect(ev.moves[1]?.visibleTo).toEqual([0])
    // 手牌忽略 position,追加到末尾(1 号玩家手牌以 P0 开头、以 S2 结尾)
    const hand1 = s.players[1]?.hand ?? []
    expect(hand1[0]).toBe(P0)
    expect(hand1[hand1.length - 1]).toBe(S2)
    expect(ev.moves[2]?.visibleTo).toEqual([0, 1])
    expect(s.players[0]?.hand).toEqual([])
    expect(() => assertCardInvariant({ state: s, registry: game.registry })).not.toThrow()
  })
})

/** 装备用例在探针体内记录的中间状态 */
interface EquipSnapshot {
  weapon: CardId | null
  horse: CardId | null
  hand: CardId[]
  all: CardId[]
}

describe('装备槽与判定区移动', () => {
  it('装备牌进入装备区落入其槽位、离开时槽位清空;zoneOf / allCardsOf 一致', () => {
    const events: CardsMoveEvent[] = []
    let mid: EquipSnapshot | null = null
    const { game } = runProbe({ players: [{ hand: [CROSSBOW, DILU, S0] }, {}] }, function* (ctx) {
      events.push(
        yield* moveCards(ctx, [
          { card: CROSSBOW, to: { kind: 'equip', player: 0 }, reason: 'equip' },
          { card: DILU, to: { kind: 'equip', player: 0 }, reason: 'equip' },
        ]),
      )
      const p = ctx.state.players[0]
      if (p === undefined) throw new Error('玩家 0 不存在')
      mid = {
        weapon: p.equips.weapon,
        horse: p.equips.horse_defensive,
        hand: [...p.hand],
        all: allCardsOf(p),
      }
      expect(zoneOf(ctx.state, CROSSBOW)).toEqual({ kind: 'equip', player: 0 })
      expect(zoneOf(ctx.state, DILU)).toEqual({ kind: 'equip', player: 0 })
      events.push(
        yield* moveCards(ctx, [{ card: CROSSBOW, to: { kind: 'discard' }, reason: 'unequip' }]),
      )
    })
    // 闭包内赋值,TS 控制流看不到:显式按声明类型读取
    const snapshot = mid as EquipSnapshot | null
    if (snapshot === null) throw new Error('探针未执行')
    expect(snapshot.weapon).toBe(CROSSBOW)
    expect(snapshot.horse).toBe(DILU)
    expect(snapshot.hand).toEqual([S0])
    // 手牌 → 槽序(weapon, armor, horse_offensive, horse_defensive)→ 判定区
    expect(snapshot.all).toEqual([S0, CROSSBOW, DILU])

    const p = game.state.players[0]
    expect(p?.equips).toEqual({
      weapon: null,
      armor: null,
      horse_offensive: null,
      horse_defensive: DILU,
    })
    expect(game.state.discardPile).toEqual([CROSSBOW])
    expect(zoneOf(game.state, CROSSBOW)).toEqual({ kind: 'discard' })
    expect(events).toHaveLength(2)
    expect(events[0]?.moves.map((m) => m.visibleTo)).toEqual([null, null])
    expect(events[1]?.moves[0]?.from).toEqual({ kind: 'equip', player: 0 })
    expect(events[1]?.moves[0]?.visibleTo).toBeNull()
    expect(() => assertCardInvariant({ state: game.state, registry: game.registry })).not.toThrow()
  })

  it('槽位已被占用时抛 EngineError(调用方须先移走旧装备)', () => {
    const { game } = probeGame(
      { players: [{ hand: [QINGGANG], equips: { weapon: CROSSBOW } }, {}] },
      function* (ctx) {
        yield* moveCards(ctx, [
          { card: QINGGANG, to: { kind: 'equip', player: 0 }, reason: 'equip' },
        ])
      },
    )
    expect(() => game.start()).toThrow(/已被占用/)
  })

  it('非装备牌与未注册的装备牌都不能进入装备区', () => {
    const slashCase = probeGame({ players: [{ hand: [S0] }, {}] }, function* (ctx) {
      yield* moveCards(ctx, [{ card: S0, to: { kind: 'equip', player: 0 }, reason: 'equip' }])
    })
    expect(() => slashCase.game.start()).toThrow(/不是可装备的牌/)

    expect(slashCase.registry.card('eight_diagram')).toBeNull()
    const unregistered = probeGame({ players: [{ hand: [EIGHT_DIAGRAM] }, {}] }, function* (ctx) {
      yield* moveCards(ctx, [
        { card: EIGHT_DIAGRAM, to: { kind: 'equip', player: 0 }, reason: 'equip' },
      ])
    })
    expect(() => unregistered.game.start()).toThrow(/不是可装备的牌/)
  })

  it('判定区:进入追加到末尾(最后放置 = 最先判定),可移回弃牌堆', () => {
    let mid: CardId[] | null = null
    let first: CardsMoveEvent | null = null
    const { game } = runProbe(
      { players: [{ hand: [INDULGENCE0, INDULGENCE1] }, {}] },
      function* (ctx) {
        first = yield* moveCards(ctx, [
          { card: INDULGENCE0, to: { kind: 'judge', player: 1 }, reason: 'delayed_trick' },
          { card: INDULGENCE1, to: { kind: 'judge', player: 1 }, reason: 'delayed_trick' },
        ])
        mid = [...(ctx.state.players[1]?.judgeArea ?? [])]
        expect(zoneOf(ctx.state, INDULGENCE0)).toEqual({ kind: 'judge', player: 1 })
        yield* moveCards(ctx, [
          { card: INDULGENCE0, to: { kind: 'discard' }, reason: 'delayed_trick' },
        ])
      },
    )
    expect(mid).toEqual([INDULGENCE0, INDULGENCE1])
    const ev = first as CardsMoveEvent | null
    if (ev === null) throw new Error('探针未执行')
    expect(ev.moves.map((m) => m.from)).toEqual([
      { kind: 'hand', player: 0 },
      { kind: 'hand', player: 0 },
    ])
    expect(ev.moves.map((m) => m.visibleTo)).toEqual([null, null])
    expect(game.state.players[1]?.judgeArea).toEqual([INDULGENCE1])
    expect(game.state.discardPile).toEqual([INDULGENCE0])
    expect(zoneOf(game.state, INDULGENCE0)).toEqual({ kind: 'discard' })
    expect(() => assertCardInvariant({ state: game.state, registry: game.registry })).not.toThrow()
  })
})

describe('zoneOf / allCardsOf', () => {
  it('六类区域都能定位;不在任何区域的牌抛 EngineError', () => {
    const registry = createTestRegistry()
    const game = buildGame(registry, {
      players: [{ hand: [S0], judgeArea: [INDULGENCE0] }, { hand: [P0] }],
      drawPileTop: [J0],
      discardPile: [J1],
    })
    const s = game.state
    expect(zoneOf(s, S0)).toEqual({ kind: 'hand', player: 0 })
    expect(zoneOf(s, P0)).toEqual({ kind: 'hand', player: 1 })
    expect(zoneOf(s, INDULGENCE0)).toEqual({ kind: 'judge', player: 0 })
    expect(zoneOf(s, J0)).toEqual({ kind: 'draw' })
    expect(zoneOf(s, J1)).toEqual({ kind: 'discard' })
    s.processing.push(s.drawPile.pop() as CardId)
    expect(zoneOf(s, s.processing[0] as CardId)).toEqual({ kind: 'processing' })
    s.players[1]?.hand.pop()
    expect(() => zoneOf(s, P0)).toThrow(EngineError)
  })
})

describe('assertCardInvariant:总牌数不变量能捕获篡改', () => {
  function freshState(): { game: Game; registry: Registry } {
    const registry = createTestRegistry()
    const game = buildGame(registry, {
      players: [{ hand: [S0, S1], judgeArea: [INDULGENCE0] }, { hand: [P0] }],
      drawPileTop: [J0],
      discardPile: [J1],
    })
    return { game, registry }
  }

  it('正常状态通过', () => {
    const { game, registry } = freshState()
    expect(() => assertCardInvariant({ state: game.state, registry })).not.toThrow()
  })

  it('直接改 state 制造重复牌被捕获', () => {
    const { game, registry } = freshState()
    game.state.discardPile.push(S0)
    expect(() => assertCardInvariant({ state: game.state, registry })).toThrow(/重复 \[0\]/)
  })

  it('直接改 state 丢失牌被捕获', () => {
    const { game, registry } = freshState()
    game.state.players[1]?.hand.pop()
    expect(() => assertCardInvariant({ state: game.state, registry })).toThrow(
      new RegExp(`缺失 \\[${P0}\\]`),
    )
  })

  it('同时丢失与重复都会列出', () => {
    const { game, registry } = freshState()
    const p0 = game.state.players[0]
    if (p0 === undefined) throw new Error('玩家 0 不存在')
    p0.hand = [S0, S0]
    expect(() => assertCardInvariant({ state: game.state, registry })).toThrow(
      new RegExp(`缺失 \\[${S1}\\],重复 \\[${S0}\\]`),
    )
  })

  it('非法牌 id(越界 / 非整数)被捕获', () => {
    const { game, registry } = freshState()
    game.state.processing.push(999)
    expect(() => assertCardInvariant({ state: game.state, registry })).toThrow(/非法牌 id 999/)
    game.state.processing.pop()
    game.state.processing.push(1.5)
    expect(() => assertCardInvariant({ state: game.state, registry })).toThrow(/非法牌 id 1.5/)
  })

  it('Game 在事件出栈 / 请求等待点断言:篡改后 step 抛错且对局进入损坏态', () => {
    const { game } = runProbe({ players: [{ hand: [S0] }, {}] }, noop)
    game.state.discardPile.push(S0)
    expect(() => answer(game, { option: PAUSE_OPTION })).toThrow(/不变量破坏/)
    expect(game.pending).toBeNull()
    expect(() => game.step({ kind: 'choice', requestId: 1, option: PAUSE_OPTION })).toThrow(
      EngineBrokenError,
    )
  })
})

describe('ensureDrawPile:弃牌堆洗回牌堆底', () => {
  it('牌堆足够时不洗牌:不消耗随机数、不产生事件、弃牌堆不变', () => {
    let ok: boolean | null = null
    let rngBefore = -1
    let eventIdBefore = -1
    const { game } = runProbe(
      withExactPiles({ players: [{}, {}], drawPileTop: [S0, S1, S2], discardPile: [J0] }),
      function* (ctx) {
        rngBefore = ctx.state.rng
        eventIdBefore = ctx.state.nextEventId
        ok = yield* ensureDrawPile(ctx, 3)
      },
    )
    expect(ok).toBe(true)
    expect(game.state.rng).toBe(rngBefore)
    expect(game.state.nextEventId).toBe(eventIdBefore)
    expect(game.state.drawPile).toEqual([S2, S1, S0])
    expect(game.state.discardPile).toEqual([J0])
    expect(game.log.filter((e) => e.type === 'reshuffle')).toEqual([])
  })

  it('牌堆不足时把弃牌堆用引擎随机源洗匀后放到牌堆底,已有顶牌顺序保持', () => {
    const discard = [P0, P1, P2, P3, P4, P5]
    const capture = captureMoves()
    let ok: boolean | null = null
    let rngBefore = -1
    const { game } = runProbe(
      withExactPiles({ players: [{}, {}], drawPileTop: [S0, S1], discardPile: discard }),
      function* (ctx) {
        rngBefore = ctx.state.rng
        ok = yield* ensureDrawPile(ctx, 5)
      },
      [capture.skill],
    )
    expect(ok).toBe(true)
    const s = game.state
    expect(s.drawPile).toHaveLength(8)
    expect(s.discardPile).toEqual([])
    // 顶部两张保持原顺序(S0 仍为顶)
    expect(s.drawPile.slice(-2)).toEqual([S1, S0])
    // 底部六张 = 用洗牌前的 rng 对弃牌堆做 Fisher–Yates 后逐张 unshift(即洗后顺序的反转)
    const expected = [...discard]
    const rngAfter = shuffleInPlace(rngBefore, expected)
    expect(s.drawPile.slice(0, 6)).toEqual([...expected].reverse())
    expect(s.rng).toBe(rngAfter)
    expect([...s.drawPile.slice(0, 6)].sort((a, b) => a - b)).toEqual(
      [...discard].sort((a, b) => a - b),
    )

    // reshuffle 日志公开数量;移动本身只公开数量(visibleTo = [])
    const reshuffle = game.log.filter((e) => e.type === 'reshuffle')
    expect(reshuffle).toHaveLength(1)
    expect(reshuffle[0]?.data).toEqual({ count: 6 })
    expect(reshuffle[0]?.visibleTo).toBeNull()
    expect(capture.events).toHaveLength(1)
    const ev = capture.events[0] as CardsMoveEvent
    expect(ev.moves).toHaveLength(6)
    for (const m of ev.moves) {
      expect(m.from).toEqual({ kind: 'discard' })
      expect(m.to).toEqual({ kind: 'draw' })
      expect(m.reason).toBe('reshuffle')
      expect(m.position).toBe('bottom')
      expect(m.visibleTo).toEqual([])
    }
    const logs = moveLogs(game, ev.id)
    const visible = logs.filter((e) => e.type === 'cardsMove')
    const hidden = logs.filter((e) => e.type === 'cardsMoveHidden')
    expect(visible).toHaveLength(1)
    expect(visible[0]?.visibleTo).toEqual([])
    expect(hidden).toHaveLength(1)
    expect(hidden[0]?.visibleTo).toEqual([0, 1])
    expect(logMoves(hidden[0] as LogEntry)).toHaveLength(6)
    expect(() => assertCardInvariant({ state: s, registry: game.registry })).not.toThrow()
  })

  it('同 seed 两次洗回得到同一顺序(确定性)', () => {
    const run = (): CardId[] => {
      const { game } = runProbe(
        withExactPiles({
          players: [{}, {}],
          seed: 2026,
          drawPileTop: [S0],
          discardPile: [P0, P1, P2, P3, J0, J1, J2],
        }),
        function* (ctx) {
          yield* ensureDrawPile(ctx, 4)
        },
      )
      return [...game.state.drawPile]
    }
    const a = run()
    const b = run()
    expect(a).toEqual(b)
    expect(a).toHaveLength(8)
    expect(a[a.length - 1]).toBe(S0)
  })

  it('洗回后仍不足且弃牌堆已空则返回 false(洗回的牌保留在牌堆)', () => {
    let ok: boolean | null = null
    const { game } = runProbe(
      withExactPiles({ players: [{}, {}], drawPileTop: [], discardPile: [P0, P1] }),
      function* (ctx) {
        ok = yield* ensureDrawPile(ctx, 3)
      },
    )
    expect(ok).toBe(false)
    expect([...game.state.drawPile].sort((a, b) => a - b)).toEqual([P0, P1])
    expect(game.state.discardPile).toEqual([])
    expect(game.state.phase).toBe('running')
  })

  it('两堆皆空:ensureDrawPile 返回 false 且不结束对局', () => {
    let ok: boolean | null = null
    const { game } = runProbe(withExactPiles({ players: [{}, {}] }), function* (ctx) {
      ok = yield* ensureDrawPile(ctx, 1)
    })
    expect(ok).toBe(false)
    expect(game.state.drawPile).toEqual([])
    expect(game.state.discardPile).toEqual([])
    expect(game.state.phase).toBe('running')
    expect(game.state.result).toBeNull()
    expect(game.log.filter((e) => e.type === 'reshuffle')).toEqual([])
  })
})

describe('两堆皆空判平局', () => {
  it('摸牌阶段牌堆与弃牌堆皆空时对局以 deckExhausted 平局结束', () => {
    const registry = createTestRegistry()
    const ids = allCards()
    const game = buildGame(registry, {
      players: [{ hand: ids.slice(0, 54) }, { hand: ids.slice(54) }],
    })
    expect(game.state.drawPile).toEqual([])
    const r = game.start()
    expect(r.type).toBe('over')
    if (r.type !== 'over') throw new Error('对局应已结束')
    expect(r.result).toEqual({ winners: [], reason: 'deckExhausted' })
    expect(game.state.phase).toBe('over')
    expect(game.state.result).toEqual({ winners: [], reason: 'deckExhausted' })
    expect(game.state.stack).toEqual([])
    expect(game.pending).toBeNull()
    expect(game.log.at(-1)?.type).toBe('gameOver')
    expect(() => assertCardInvariant({ state: game.state, registry })).not.toThrow()
    expect(() => game.step({ kind: 'play', requestId: 1, action: 'end' })).toThrow(EngineError)
  })

  it('peekDrawPile 在两堆皆空时直接判平局(GameOver 穿过所有 finally)', () => {
    const { game } = probeGame(withExactPiles({ players: [{}, {}] }), function* (ctx) {
      yield* peekDrawPile(ctx, 1)
    })
    const r = game.start()
    expect(r.type).toBe('over')
    expect(game.state.result).toEqual({ winners: [], reason: 'deckExhausted' })
    expect(game.state.stack).toEqual([])
    expect(game.state.turn).toBeNull()
  })
})

describe('peekDrawPile / drawFromPile', () => {
  it('peekDrawPile 返回顶部 n 张(第 0 项为顶)且不移动、不产生事件', () => {
    const capture = captureMoves()
    let peeked: CardId[] | null = null
    let pileBefore: CardId[] | null = null
    let eventIdBefore = -1
    const { game } = runProbe(
      withExactPiles({ players: [{}, {}], drawPileTop: [S0, S1, S2, S3] }),
      function* (ctx) {
        pileBefore = [...ctx.state.drawPile]
        eventIdBefore = ctx.state.nextEventId
        peeked = yield* peekDrawPile(ctx, 3)
      },
      [capture.skill],
    )
    expect(peeked).toEqual([S0, S1, S2])
    expect(game.state.drawPile).toEqual(pileBefore)
    expect(game.state.drawPile).toEqual([S3, S2, S1, S0])
    expect(game.state.nextEventId).toBe(eventIdBefore)
    expect(capture.events).toEqual([])
    expect(game.log.filter((e) => e.type === 'cardsMove')).toEqual([])
  })

  it('peekDrawPile 牌堆不足时先洗回再返回,已有顶牌仍在最前', () => {
    let peeked: CardId[] | null = null
    const { game } = runProbe(
      withExactPiles({ players: [{}, {}], drawPileTop: [S0], discardPile: [P0, P1, P2] }),
      function* (ctx) {
        peeked = yield* peekDrawPile(ctx, 2)
      },
    )
    const got = peeked as CardId[] | null
    if (got === null) throw new Error('探针未执行')
    expect(got).toHaveLength(2)
    expect(got[0]).toBe(S0)
    expect([P0, P1, P2]).toContain(got[1])
    expect(game.state.drawPile).toHaveLength(4)
    expect(game.state.discardPile).toEqual([])
    expect(game.state.drawPile.slice(-2)).toEqual([got[1], S0])
  })

  it('drawFromPile 逐张从牌堆顶摸入手牌,每张一条只对本人可见的 CardsMove', () => {
    const capture = captureMoves()
    let drawn: CardId[] | null = null
    const { game } = runProbe(
      withExactPiles({ players: [{}, { hand: [P0] }], drawPileTop: [S0, S1, S2] }),
      function* (ctx) {
        drawn = yield* drawFromPile(ctx, 1, 2)
      },
      [capture.skill],
    )
    expect(drawn).toEqual([S0, S1])
    expect(game.state.players[1]?.hand).toEqual([P0, S0, S1])
    expect(game.state.drawPile).toEqual([S2])
    expect(capture.events).toHaveLength(2)
    expect(capture.events.map((e) => e.moves.length)).toEqual([1, 1])
    for (const ev of capture.events) {
      const m = ev.moves[0]
      expect(m?.from).toEqual({ kind: 'draw' })
      expect(m?.to).toEqual({ kind: 'hand', player: 1 })
      expect(m?.reason).toBe('draw')
      expect(m?.visibleTo).toEqual([1])
    }
    expect(capture.events.map((e) => e.moves[0]?.card)).toEqual([S0, S1])
  })
})

describe('reorderDrawPile:牌堆内部重排不是移动', () => {
  it('按给定顺序放到牌堆顶(第 0 项为顶),不触发 CardsMove、不消耗随机数、不写日志', () => {
    const capture = captureMoves()
    let rngBefore = -1
    let eventIdBefore = -1
    const { game } = runProbe(
      withExactPiles({ players: [{}, {}], drawPileTop: [S0, S1, S2, S3, S4] }),
      function* (ctx) {
        rngBefore = ctx.state.rng
        eventIdBefore = ctx.state.nextEventId
        reorderDrawPile(ctx, [S3, S1], 'top')
        yield* []
      },
      [capture.skill],
    )
    // 顶→底:S3, S1, S0, S2, S4;数组末尾为顶
    expect(game.state.drawPile).toEqual([S4, S2, S0, S1, S3])
    expect(game.state.rng).toBe(rngBefore)
    expect(game.state.nextEventId).toBe(eventIdBefore)
    expect(capture.events).toEqual([])
    expect(game.log.filter((e) => e.type === 'cardsMove' || e.type === 'cardsMoveHidden')).toEqual(
      [],
    )
    expect(() => assertCardInvariant({ state: game.state, registry: game.registry })).not.toThrow()
  })

  it('按给定顺序放到牌堆底(第 0 项最靠近顶)', () => {
    const capture = captureMoves()
    const { game } = runProbe(
      withExactPiles({ players: [{}, {}], drawPileTop: [S0, S1, S2, S3, S4] }),
      function* (ctx) {
        reorderDrawPile(ctx, [S0, S2], 'bottom')
        yield* []
      },
      [capture.skill],
    )
    // 顶→底:S1, S3, S4, S0, S2
    expect(game.state.drawPile).toEqual([S2, S0, S4, S3, S1])
    expect(capture.events).toEqual([])
  })

  it('不在牌堆中的牌不能重排,抛 EngineError', () => {
    const { game } = probeGame(
      withExactPiles({ players: [{ hand: [J0] }, {}], drawPileTop: [S0, S1] }),
      function* (ctx) {
        reorderDrawPile(ctx, [J0], 'top')
        yield* []
      },
    )
    expect(() => game.start()).toThrow(/不在牌堆中/)
  })
})
