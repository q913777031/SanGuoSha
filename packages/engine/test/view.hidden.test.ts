/**
 * view.hidden.test.ts ─ 信息隐藏(设计 §8):viewFor 纯函数、handCount、日志可见性分组、
 * EventSummary 遮蔽、waitingFor,以及随机对局中"隐藏牌 id 不出现在他人 view / Request / 日志"的 fuzz。
 */
import { describe, expect, it } from 'vitest'

import { createRandomController } from '@sgs/ai'

import type { CardId, CardName, GameState, LogEntry, PlayerId, Registry } from '../src/index.js'
import { EngineError, Game, createStandardRegistry, visibleTo } from '../src/index.js'
import { answer, buildGame, expectRequest } from '../src/testing/index.js'

const registry = createStandardRegistry()

/** 牌表中前 count 张名为 name 的牌 id */
function cardsNamed(reg: Registry, name: CardName, count: number): CardId[] {
  const ids = reg.deck.filter((c) => c.name === name).map((c) => c.id)
  if (ids.length < count) throw new EngineError(`牌表中 ${name} 不足 ${count} 张`)
  return ids.slice(0, count)
}

/** 牌 → 所在区域键('draw' / 'discard' / 'processing' / 'hand:p' / 'equip:p' / 'judge:p') */
type ZoneMap = Map<CardId, string>

function zonesOf(state: GameState): ZoneMap {
  const m: ZoneMap = new Map()
  for (const c of state.drawPile) m.set(c, 'draw')
  for (const c of state.discardPile) m.set(c, 'discard')
  for (const c of state.processing) m.set(c, 'processing')
  for (const p of state.players) {
    for (const c of p.hand) m.set(c, `hand:${p.id}`)
    for (const c of p.judgeArea) m.set(c, `judge:${p.id}`)
    for (const c of Object.values(p.equips)) if (c !== null) m.set(c, `equip:${p.id}`)
  }
  return m
}

/** 对 viewer 隐藏的牌:牌堆 + 他人手牌 */
function hiddenFor(zones: ZoneMap, viewer: PlayerId): Set<CardId> {
  const out = new Set<CardId>()
  for (const [c, z] of zones)
    if (z === 'draw' || (z.startsWith('hand:') && z !== `hand:${viewer}`)) out.add(c)
  return out
}

/** 数值一定不是牌 id 的键(玩家 / 事件 / 请求 id、计数、点数等);其余位置的数字一律按牌 id 检查 */
const NON_CARD_KEYS = new Set([
  'seq',
  'visibleTo',
  'id',
  'eventId',
  'requestId',
  'reason',
  'event',
  'against',
  'player',
  'source',
  'from',
  'to',
  'targets',
  'fixedTargets',
  'killer',
  'winners',
  'me',
  'waitingFor',
  'hp',
  'maxHp',
  'handCount',
  'count',
  'amount',
  'turnCount',
  'drawPileCount',
  'number',
  'numberRange',
  'min',
  'max',
  'index',
  'marks',
  'counters',
  'args',
])

/** 遍历 JSON,返回值等于隐藏 id 的数字所在路径(键为 NON_CARD_KEYS 的子树跳过) */
function leaks(value: unknown, hidden: ReadonlySet<CardId>, path = '$'): string[] {
  if (typeof value === 'number') return hidden.has(value) ? [`${path}=${value}`] : []
  if (value === null || typeof value !== 'object') return []
  const out: string[] = []
  for (const [k, v] of Object.entries(value)) {
    if (!Array.isArray(value) && NON_CARD_KEYS.has(k)) continue
    out.push(...leaks(v, hidden, `${path}.${k}`))
  }
  return out
}

interface LoggedMove {
  card: CardId
  to: { kind: string; player?: PlayerId }
}

function zoneKey(z: LoggedMove['to']): string {
  return z.player === undefined ? z.kind : `${z.kind}:${z.player}`
}

function intersect(a: Set<CardId>, b: Set<CardId>): Set<CardId> {
  return new Set([...a].filter((c) => b.has(c)))
}

/** 按本步全部 cardsMove 日志(不论可见性)依次重放区域:snaps[0] 为步前,snaps[k] 为第 k 条 cardsMove 之后 */
function replay(start: GameState, logs: readonly LogEntry[]): ZoneMap[] {
  const snaps: ZoneMap[] = [zonesOf(start)]
  for (const e of logs) {
    if (e.type !== 'cardsMove') continue
    const next = new Map(snaps[snaps.length - 1])
    for (const m of (e.data as unknown as { moves: LoggedMove[] }).moves)
      next.set(m.card, zoneKey(m.to))
    snaps.push(next)
  }
  return snaps
}

/**
 * 一步内增量日志的泄露:一条日志可向 p 提及某牌,当且仅当该牌在其写入前后相邻两个区域快照之一对 p 可见
 * (cardsMove 取移动前 / 后;其他日志取当前 / 下一条 cardsMove 之后,容许"先记弃牌、再移牌"的顺序)。
 */
function logLeaks(snaps: ZoneMap[], logs: readonly LogEntry[], players: number): string[] {
  const out: string[] = []
  let k = 0
  for (const e of logs) {
    const before = snaps[k] as ZoneMap
    if (e.type === 'cardsMove') k++
    const after = snaps[e.type === 'cardsMove' ? k : k + 1] ?? before
    for (let p = 0; p < players; p++) {
      if (e.visibleTo !== null && !e.visibleTo.includes(p)) continue
      const hidden = intersect(hiddenFor(before, p), hiddenFor(after, p))
      for (const l of leaks(e, hidden)) out.push(`日志 #${e.seq}(${e.type})→ 玩家 ${p}:${l}`)
    }
  }
  return out
}

function sortedEntries(m: ZoneMap): Array<[CardId, string]> {
  return [...m].sort((a, b) => a[0] - b[0])
}

describe('信息隐藏 fuzz:随机对局每个等待点', () => {
  it('检测器自检:原始 GameState 对任一玩家都会被判为泄露', () => {
    const state = buildGame(registry, { players: [{}, {}] }).state
    expect(leaks(state, hiddenFor(zonesOf(state), 1)).length).toBeGreaterThan(0)
  })

  it.each([
    [5, 1],
    [5, 2],
    [5, 3],
    [8, 4],
  ])(
    '%i 人 seed=%i:view / Request / 日志不含隐藏牌 id,handCount 与 waitingFor 正确,摘要遮蔽',
    (n, seed) => {
      const game = new Game(
        {
          seed,
          mode: 'ffa',
          players: Array.from({ length: n }, () => ({ general: null })),
          fixedDeckOrder: null,
          options: {
            assertInvariants: true,
            detectUnconsumedFlows: true,
            invalidResponsePolicy: 'throw',
          },
        },
        registry,
      )
      const ais = Array.from({ length: n }, (_, p) => createRandomController(seed, p))
      const problems: string[] = []
      let before = structuredClone(game.state)
      let r = game.start()
      let steps = 0
      for (;;) {
        const s = game.state
        const snaps = replay(before, r.logs)
        problems.push(...logLeaks(snaps, r.logs, n))
        const zones = zonesOf(s)
        expect(sortedEntries(zones), '日志 cardsMove 重放应与实际区域一致').toStrictEqual(
          sortedEntries(snaps[snaps.length - 1] as ZoneMap),
        )
        const waiting = r.type === 'request' ? r.request.player : null
        for (let p = 0; p < n; p++) {
          const hashBefore = game.stateHash()
          const view = game.viewFor(p)
          expect(game.viewFor(p), 'viewFor 应为纯函数').toStrictEqual(view)
          expect(game.stateHash()).toBe(hashBefore)
          const hidden = hiddenFor(zones, p)
          for (const l of leaks(view, hidden)) problems.push(`第 ${steps} 步 view(${p}):${l}`)
          expect(view.hand).toStrictEqual(s.players[p]?.hand)
          expect(view.players.map((q) => q.handCount)).toStrictEqual(
            s.players.map((q) => q.hand.length),
          )
          expect(view.waitingFor).toBe(waiting)
          for (const sum of view.stack) {
            expect(Object.keys(sum).sort()).toStrictEqual([
              'card',
              'id',
              'kind',
              'source',
              'targets',
            ])
            expect(['CardsMove', 'DrawCards']).not.toContain(sum.kind)
          }
          // 视图是副本:改动不影响状态
          view.hand.push(-1)
          view.players[p]?.judgeArea.push(-1)
          expect(game.stateHash()).toBe(hashBefore)
        }
        if (r.type === 'over') break
        const req = r.request
        for (const l of leaks(req, hiddenFor(zones, req.player)))
          problems.push(`第 ${steps} 步 Request(${req.kind}→${req.player}):${l}`)
        steps++
        before = structuredClone(s)
        const ai = ais[req.player]
        if (ai === undefined) throw new EngineError(`玩家 ${req.player} 没有控制器`)
        r = game.step(ai.respond(req))
      }
      expect(steps).toBeGreaterThan(50)
      expect(problems).toStrictEqual([])
    },
  )
})

describe('日志可见性分组', () => {
  it('摸牌:牌堆 → 手牌的 cardsMove 仅 owner 可见,他人只收到无 id 的 cardsMoveHidden', () => {
    const top = cardsNamed(registry, 'jink', 2)
    const game = buildGame(registry, {
      players: [{}, {}, {}],
      drawPileTop: top,
    })
    const r = game.start()
    expect(r.type).toBe('request')
    // 逐张摸牌:每张一条 CardsMove,各自分组为 [owner] 的明细 + 他人的无 id 数量条目
    const moves = r.logs.filter((e) => e.type === 'cardsMove')
    expect(moves.map((e) => e.visibleTo)).toStrictEqual([[0], [0]])
    expect(moves.map((e) => e.data)).toStrictEqual(
      top.map((card) => ({
        moves: [{ card, from: { kind: 'draw' }, to: { kind: 'hand', player: 0 }, reason: 'draw' }],
      })),
    )
    const hidden = r.logs.filter((e) => e.type === 'cardsMoveHidden')
    expect(hidden.map((e) => e.visibleTo)).toStrictEqual([
      [1, 2],
      [1, 2],
    ])
    expect(JSON.stringify(hidden.map((e) => e.data))).not.toMatch(/"card"/)
    // 按玩家过滤:1 号看不到 id
    expect(visibleTo(r.logs, 1).some((e) => e.type === 'cardsMove')).toBe(false)
    expect(visibleTo(r.logs, 0).some((e) => e.type === 'cardsMoveHidden')).toBe(false)
  })

  it('弃牌:手牌 → 弃牌堆的 cardsMove 公开(visibleTo = null)', () => {
    const hand = cardsNamed(registry, 'jink', 3)
    const game = buildGame(registry, {
      players: [{ hp: 1, hand }, {}],
      drawPileTop: cardsNamed(registry, 'peach', 2),
    })
    game.start()
    answer(game, { action: 'end' })
    const req = expectRequest(game, 'chooseCards')
    expect(req.min).toBe(4)
    const r = answer(game, { indices: [0, 1, 2, 3] })
    const discard = r.logs.find((e) => e.type === 'cardsMove')
    expect(discard?.visibleTo).toBeNull()
    expect(r.logs.some((e) => e.type === 'cardsMoveHidden' && e.eventId === discard?.eventId)).toBe(
      false,
    )
    const discarded = req.candidates.slice(0, 4).map((c) => c.card)
    expect(game.viewFor(1).discardPile).toStrictEqual(expect.arrayContaining(discarded))
  })
})

describe('EventSummary 遮蔽与 waitingFor', () => {
  it('被杀者响应闪时:双方视图的 AskCard 摘要不含 pattern / candidates,waitingFor = 被询问者', () => {
    const [slash] = cardsNamed(registry, 'slash', 1) as [CardId]
    const jinks = cardsNamed(registry, 'jink', 2)
    const game = buildGame(registry, {
      players: [{ hand: [slash] }, { hand: jinks }, {}],
      drawPileTop: cardsNamed(registry, 'peach', 2),
    })
    game.start()
    expect(game.viewFor(2).waitingFor).toBe(0)
    answer(game, { action: 'useCard', card: slash, targets: [1] })
    const req = expectRequest(game, 'askCard')
    expect(req.player).toBe(1)
    expect([...req.candidates].sort()).toStrictEqual([...jinks].sort())
    for (const p of [0, 1, 2]) {
      const view = game.viewFor(p)
      expect(view.waitingFor).toBe(1)
      const ask = view.stack.find((e) => e.kind === 'AskCard')
      expect(ask).toStrictEqual({
        id: ask?.id,
        kind: 'AskCard',
        card: null,
        source: 1,
        targets: [],
      })
      expect(JSON.stringify(view.stack)).not.toMatch(/pattern|candidates/)
      expect(view.stack.map((e) => e.kind)).not.toContain('CardsMove')
      expect(view.players[1]?.handCount).toBe(2)
      if (p !== 1)
        expect(JSON.stringify(view)).not.toMatch(new RegExp(`\\b(${jinks.join('|')})\\b`))
    }
    answer(game, { card: jinks[0] as CardId, viewAs: null, targets: [] })
    expect(game.viewFor(2).players[1]?.handCount).toBe(1)
    expect(game.viewFor(2).waitingFor).toBe(0)
  })

  it('对局结束后 waitingFor = null、result 可见', () => {
    const [slash] = cardsNamed(registry, 'slash', 1) as [CardId]
    const game = buildGame(registry, {
      players: [{ hand: [slash] }, { hp: 1 }],
      drawPileTop: cardsNamed(registry, 'jink', 2),
    })
    game.start()
    const r = answer(game, { action: 'useCard', card: slash, targets: [1] })
    expect(r.type).toBe('over')
    for (const p of [0, 1]) {
      const view = game.viewFor(p)
      expect(view.waitingFor).toBeNull()
      expect(view.result?.winners).toStrictEqual([0])
    }
  })
})
