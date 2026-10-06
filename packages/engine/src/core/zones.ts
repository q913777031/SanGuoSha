/**
 * core/zones.ts ─ 牌的区域:定位、移动、牌堆维护与总牌数不变量。
 * moveCards() 是唯一改变牌位置的入口(作为 CardsMove 事件运行,原子应用见 applyMoves)。
 */
import { EngineError, gameOver, runEvent } from './engine.js'
import { guardFlow } from './flow.js'
import type {
  CardId,
  CardMove,
  CardName,
  CardMoveDraft,
  CardsMoveEvent,
  Ctx,
  Flow,
  GameState,
  PlayerId,
  PlayerState,
  Zone,
} from './types.js'
import { EQUIP_SLOTS } from './types.js'

/** 牌当前所在区域;找不到即不变量已被破坏 */
export function zoneOf(state: GameState, card: CardId): Zone {
  for (const p of state.players) {
    if (p.hand.includes(card)) return { kind: 'hand', player: p.id }
    if (p.judgeArea.includes(card)) return { kind: 'judge', player: p.id }
    for (const slot of EQUIP_SLOTS)
      if (p.equips[slot] === card) return { kind: 'equip', player: p.id }
  }
  if (state.drawPile.includes(card)) return { kind: 'draw' }
  if (state.discardPile.includes(card)) return { kind: 'discard' }
  if (state.processing.includes(card)) return { kind: 'processing' }
  throw new EngineError(`牌 ${card} 不在任何区域`)
}

/** 玩家所有的牌:手牌 + 装备(槽序)+ 判定区 */
export function allCardsOf(p: PlayerState): CardId[] {
  const cards = [...p.hand]
  for (const slot of EQUIP_SLOTS) {
    const card = p.equips[slot]
    if (card !== null) cards.push(card)
  }
  cards.push(...p.judgeArea)
  return cards
}

/**
 * 移动的可见性:牌堆 ↔ 手牌仅 owner;手牌 → 手牌双方;进入牌堆的其他移动(洗回)对谁都不可见(只公开数量);
 * 其余公开(null)。
 */
export function moveVisibility(from: Zone, to: Zone): PlayerId[] | null {
  if (from.kind === 'hand' && to.kind === 'hand') {
    return from.player === to.player ? [from.player] : [from.player, to.player]
  }
  if (from.kind === 'draw' && to.kind === 'hand') return [to.player]
  if (from.kind === 'hand' && to.kind === 'draw') return [from.player]
  if (to.kind === 'draw') return []
  return null
}

/** 把若干牌移动到目标区域(作为一条 CardsMove 事件);from / visibleTo 由引擎推导 */
export function moveCards(ctx: Ctx, drafts: CardMoveDraft[]): Flow<CardsMoveEvent> {
  return guardFlow(ctx, 'moveCards', () => moveCardsBody(ctx, drafts))
}

function* moveCardsBody(ctx: Ctx, drafts: CardMoveDraft[]): Flow<CardsMoveEvent> {
  const moves: CardMove[] = drafts.map((d) => {
    const from = zoneOf(ctx.state, d.card)
    return {
      card: d.card,
      from,
      to: d.to,
      reason: d.reason,
      position: d.position ?? 'top',
      visibleTo: moveVisibility(from, d.to),
      as: d.as ?? null,
    }
  })
  return yield* runEvent(ctx, { kind: 'CardsMove', moves })
}

function removeFrom(state: GameState, card: CardId, zone: Zone): void {
  const take = (list: CardId[]): boolean => {
    const i = list.indexOf(card)
    if (i < 0) return false
    list.splice(i, 1)
    return true
  }
  let ok = false
  switch (zone.kind) {
    case 'hand':
      ok = take(playerAt(state, zone.player).hand)
      break
    case 'judge': {
      const p = playerAt(state, zone.player)
      ok = take(p.judgeArea)
      delete p.judgeAs[String(card)]
      break
    }
    case 'equip': {
      const p = playerAt(state, zone.player)
      for (const slot of EQUIP_SLOTS) {
        if (p.equips[slot] === card) {
          p.equips[slot] = null
          ok = true
        }
      }
      break
    }
    case 'draw':
      ok = take(state.drawPile)
      break
    case 'discard':
      ok = take(state.discardPile)
      break
    case 'processing':
      ok = take(state.processing)
      break
  }
  if (!ok) throw new EngineError(`牌 ${card} 不在预期的来源区域 ${zone.kind}`)
}

function addTo(
  ctx: Ctx,
  card: CardId,
  zone: Zone,
  position: 'top' | 'bottom',
  as: CardName | null,
): void {
  const state = ctx.state
  switch (zone.kind) {
    case 'hand':
      playerAt(state, zone.player).hand.push(card)
      break
    case 'judge': {
      const p = playerAt(state, zone.player)
      p.judgeArea.push(card)
      // 转化而来的延时锦囊(国色当乐)记住牌名,判定阶段按它结算
      if (as !== null && as !== ctx.registry.spec(card).name) p.judgeAs[String(card)] = as
      break
    }
    case 'equip': {
      const def = ctx.registry.card(ctx.registry.spec(card).name)
      if (def === null || def.equip === null) throw new EngineError(`牌 ${card} 不是可装备的牌`)
      const p = playerAt(state, zone.player)
      if (p.equips[def.equip.slot] !== null) {
        throw new EngineError(
          `玩家 ${zone.player} 的 ${def.equip.slot} 槽已被占用,调用方须先移走旧装备`,
        )
      }
      p.equips[def.equip.slot] = card
      break
    }
    case 'draw':
      if (position === 'bottom') state.drawPile.unshift(card)
      else state.drawPile.push(card)
      break
    case 'discard':
      state.discardPile.push(card)
      break
    case 'processing':
      state.processing.push(card)
      break
  }
}

function playerAt(state: GameState, id: PlayerId): PlayerState {
  const p = state.players[id]
  if (p === undefined) throw new EngineError(`玩家 ${id} 不存在`)
  return p
}

/** 原子应用一组移动(CardsMove handler 调用):逐张从来源区移除、加入目标区;from 以应用时的实际区域为准 */
export function applyMoves(ctx: Ctx, moves: CardMove[]): void {
  const seen: boolean[] = []
  for (const m of moves) {
    if (seen[m.card]) throw new EngineError(`同一条 CardsMove 中牌 ${m.card} 出现了两次`)
    seen[m.card] = true
  }
  for (const m of moves) {
    const from = zoneOf(ctx.state, m.card)
    m.from = from
    m.visibleTo = moveVisibility(from, m.to)
    removeFrom(ctx.state, m.card, from)
    addTo(ctx, m.card, m.to, m.position, m.as)
  }
}

/**
 * 保证牌堆至少有 n 张:不足则把弃牌堆洗匀后洗入牌堆底(保持已有顶牌顺序);
 * 两者皆空返回 false(调用方决定平局)。
 */
export function ensureDrawPile(ctx: Ctx, n: number): Flow<boolean> {
  return guardFlow(ctx, 'ensureDrawPile', () => ensureDrawPileBody(ctx, n))
}

function* ensureDrawPileBody(ctx: Ctx, n: number): Flow<boolean> {
  const s = ctx.state
  while (s.drawPile.length < n) {
    if (s.discardPile.length === 0) return false
    const before = s.drawPile.length
    const cards = [...s.discardPile]
    ctx.shuffle(cards)
    const top = s.stack[s.stack.length - 1]
    ctx.log({
      type: 'reshuffle',
      data: { count: cards.length },
      visibleTo: null,
      eventId: top === undefined ? null : top.id,
    })
    yield* moveCards(
      ctx,
      cards.map((card) => ({
        card,
        to: { kind: 'draw' as const },
        reason: 'reshuffle' as const,
        position: 'bottom' as const,
      })),
    )
    if (s.drawPile.length <= before) return false
  }
  return true
}

/** 保证牌堆够 n 张并返回顶部 n 张的 id(第 0 项为顶),不移动;牌堆与弃牌堆皆空则判平局结束 */
export function peekDrawPile(ctx: Ctx, n: number): Flow<CardId[]> {
  return guardFlow(ctx, 'peekDrawPile', () => peekDrawPileBody(ctx, n))
}

function* peekDrawPileBody(ctx: Ctx, n: number): Flow<CardId[]> {
  const ok = yield* ensureDrawPile(ctx, n)
  if (!ok) gameOver(ctx, { winners: [], reason: 'deckExhausted' })
  return ctx.state.drawPile.slice(-n).reverse()
}

/** 从牌堆顶逐张摸 count 张到玩家手牌(reason 'draw'),返回摸到的牌 */
export function drawFromPile(ctx: Ctx, player: PlayerId, count: number): Flow<CardId[]> {
  return guardFlow(ctx, 'drawFromPile', () => drawFromPileBody(ctx, player, count))
}

function* drawFromPileBody(ctx: Ctx, player: PlayerId, count: number): Flow<CardId[]> {
  const drawn: CardId[] = []
  for (let i = 0; i < count; i++) {
    const [card] = yield* peekDrawPile(ctx, 1)
    if (card === undefined) throw new EngineError('牌堆顶为空')
    yield* moveCards(ctx, [{ card, to: { kind: 'hand', player }, reason: 'draw' }])
    drawn.push(card)
  }
  return drawn
}

/** 牌堆内部重排(观星):把给定的牌(须都在牌堆)按给定顺序放到牌堆顶或底;不是移动,不触发 CardsMove */
export function reorderDrawPile(ctx: Ctx, cards: CardId[], position: 'top' | 'bottom'): void {
  const pile = ctx.state.drawPile
  for (const card of cards) {
    const i = pile.indexOf(card)
    if (i < 0) throw new EngineError(`牌 ${card} 不在牌堆中,不能重排`)
    pile.splice(i, 1)
  }
  if (position === 'top') {
    for (let i = cards.length - 1; i >= 0; i--) pile.push(cards[i] as CardId)
  } else {
    for (const card of cards) pile.unshift(card)
  }
}

/** 开局牌堆:config.fixedDeckOrder(须为全部牌的一个排列,末尾为顶)或按种子洗牌 */
export function initializeDrawPile(ctx: Ctx): void {
  const s = ctx.state
  const fixed = ctx.config.fixedDeckOrder
  if (fixed === null) {
    ctx.shuffle(s.drawPile)
    return
  }
  const total = ctx.registry.deck.length
  if (fixed.length !== total)
    throw new EngineError(`fixedDeckOrder 长度 ${fixed.length} ≠ 牌数 ${total}`)
  const seen: boolean[] = []
  for (const card of fixed) {
    if (!Number.isInteger(card) || card < 0 || card >= total || seen[card]) {
      throw new EngineError(`fixedDeckOrder 不是全部牌的排列(牌 ${card})`)
    }
    seen[card] = true
  }
  s.drawPile = [...fixed]
}

/** 总牌数不变量:每张牌恰好出现一次(手牌 + 装备 + 判定区 + 牌堆 + 弃牌堆 + 处理区);只需状态与注册表 */
export function assertCardInvariant(ctx: Pick<Ctx, 'state' | 'registry'>): void {
  const s = ctx.state
  const total = ctx.registry.deck.length
  const count: number[] = []
  for (let i = 0; i < total; i++) count.push(0)
  const tally = (card: CardId, where: string): void => {
    if (!Number.isInteger(card) || card < 0 || card >= total) {
      throw new EngineError(`不变量破坏:${where} 含非法牌 id ${card}`)
    }
    count[card] = (count[card] ?? 0) + 1
  }
  for (const p of s.players) {
    for (const c of p.hand) tally(c, `玩家 ${p.id} 手牌`)
    for (const c of p.judgeArea) tally(c, `玩家 ${p.id} 判定区`)
    for (const slot of EQUIP_SLOTS) {
      const c = p.equips[slot]
      if (c !== null) tally(c, `玩家 ${p.id} ${slot}`)
    }
  }
  for (const c of s.drawPile) tally(c, '牌堆')
  for (const c of s.discardPile) tally(c, '弃牌堆')
  for (const c of s.processing) tally(c, '处理区')
  const missing: CardId[] = []
  const duplicated: CardId[] = []
  for (let i = 0; i < total; i++) {
    const n = count[i] ?? 0
    if (n === 0) missing.push(i)
    else if (n > 1) duplicated.push(i)
  }
  if (missing.length > 0 || duplicated.length > 0) {
    throw new EngineError(`不变量破坏:缺失 [${missing.join(',')}],重复 [${duplicated.join(',')}]`)
  }
}
