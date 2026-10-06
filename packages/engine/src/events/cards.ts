/**
 * events/cards.ts ─ 牌相关事件:DrawCards、CardsMove、AskCard、CardUse、CardRespond、CardEffect 与无懈链。
 * 时机顺序见 ENGINE_DESIGN.md §3.2,由快照测试锁住。
 */
import { EngineError, runEvent, stage } from '../core/engine.js'
import { ask, askCard, guardFlow } from '../core/flow.js'
import { cloneJson } from '../core/hash.js'
import { fold } from '../core/modifiers.js'
import {
  anchor,
  defaultNullifiable,
  faceOf,
  faceToJson,
  matchingCards,
  orderTargets,
  playerOf,
  playersFrom,
  resolveUseTargets,
  viewAsFace,
  viewAsOptions,
  zoneToJson,
} from '../core/state.js'
import type {
  AskCardEvent,
  CardDef,
  CardEffectEvent,
  CardMove,
  CardRespondEvent,
  CardsMoveEvent,
  CardUseEvent,
  Ctx,
  DrawCardsEvent,
  Flow,
  PlayerId,
} from '../core/types.js'
import { applyMoves, drawFromPile, moveCards, zoneOf } from '../core/zones.js'
import { byName } from '../cards/pattern.js'

/** DrawCards:DrawCards.before(改量 / 取消)→ [已死亡 ⇒ 取消] → 逐张从牌堆顶摸入手牌 → DrawCards.after */
export function* onDrawCards(ctx: Ctx, ev: DrawCardsEvent): Flow<void> {
  if (!(yield* stage(ctx, 'DrawCards.before', ev))) return
  // 已死亡(含在 DrawCards.before 时机死亡)的角色不摸牌:否则牌会永远留在死者手里
  if (!playerOf(ctx, ev.player).alive) {
    ev.cancelled = true
    return
  }
  if (ev.count > 0) {
    const cards = yield* drawFromPile(ctx, ev.player, ev.count)
    ev.cards.push(...cards)
    ctx.log({
      type: 'draw',
      data: { player: ev.player, count: cards.length, reason: ev.reason },
      visibleTo: null,
      eventId: ev.id,
    })
  }
  yield* stage(ctx, 'DrawCards.after', ev)
}

function logMoves(ctx: Ctx, ev: CardsMoveEvent): void {
  const groups: Array<{ key: string; visibleTo: PlayerId[] | null; moves: CardMove[] }> = []
  for (const m of ev.moves) {
    const key = m.visibleTo === null ? '*' : m.visibleTo.join(',')
    let group = groups.find((g) => g.key === key)
    if (group === undefined) {
      group = { key, visibleTo: m.visibleTo, moves: [] }
      groups.push(group)
    }
    group.moves.push(m)
  }
  for (const g of groups) {
    ctx.log({
      type: 'cardsMove',
      data: {
        moves: g.moves.map((m) => ({
          card: m.card,
          from: zoneToJson(m.from),
          to: zoneToJson(m.to),
          reason: m.reason,
        })),
      },
      visibleTo: g.visibleTo,
      eventId: ev.id,
    })
    const visible = g.visibleTo
    if (visible === null) continue
    ctx.log({
      type: 'cardsMoveHidden',
      data: {
        moves: g.moves.map((m) => ({
          from: zoneToJson(m.from),
          to: zoneToJson(m.to),
          reason: m.reason,
        })),
      },
      visibleTo: ctx.state.players.map((p) => p.id).filter((id) => !visible.includes(id)),
      eventId: ev.id,
    })
  }
}

/** CardsMove:CardsMove.before(可取消)→ 原子移动 → 按可见性分组写日志 → CardsMove.after */
export function* onCardsMove(ctx: Ctx, ev: CardsMoveEvent): Flow<void> {
  if (ev.moves.length === 0) return
  if (!(yield* stage(ctx, 'CardsMove.before', ev))) return
  applyMoves(ctx, ev.moves)
  logMoves(ctx, ev)
  yield* stage(ctx, 'CardsMove.after', ev)
}

/**
 * AskCard:AskCard.before(八卦阵填 result / 铁骑取消)→ 有候选才发 askCard 请求 →
 * 使用(CardUse)或打出(CardRespond)→ AskCard.after。无牌可出时不发 Request(只依赖状态,确定)。
 */
export function* onAskCard(ctx: Ctx, ev: AskCardEvent): Flow<void> {
  if (!(yield* stage(ctx, 'AskCard.before', ev))) return
  if (!ev.result.responded) {
    const candidates = matchingCards(ctx, ev.player, ev.pattern)
    const viewAsSkills = viewAsOptions(ctx, ev.player, ev.pattern, ev.mode)
    if (candidates.length > 0 || viewAsSkills.length > 0) {
      const r = yield* ask(ctx, {
        kind: 'askCard',
        player: ev.player,
        pattern: cloneJson(ev.pattern),
        mode: ev.mode,
        candidates,
        viewAsSkills,
        fixedTargets: [...ev.targets],
        targets: null,
        against: ev.againstId,
        reason: ev.reasonId,
        prompt: cloneJson(ev.prompt),
      })
      const face =
        r.card !== null
          ? faceOf(ctx, r.card)
          : r.viewAs !== null
            ? viewAsFace(ctx, ev.player, r.viewAs, ev.pattern)
            : null
      if (face !== null) {
        if (ev.mode === 'use') {
          yield* runEvent(ctx, {
            kind: 'CardUse',
            source: ev.player,
            card: face,
            targets: resolveUseTargets(ctx, ev.player, face, ev.targets),
            currentTarget: null,
            reason: 'response',
            againstId: ev.againstId,
            nullifiable: defaultNullifiable(ctx, face),
            responseCounts: {},
          })
        } else {
          yield* runEvent(ctx, {
            kind: 'CardRespond',
            player: ev.player,
            card: face,
            againstId: ev.againstId,
            reasonId: ev.reasonId,
          })
        }
        ev.result = { responded: true, card: face }
      }
    }
  }
  yield* stage(ctx, 'AskCard.after', ev)
}

/**
 * CardUse:牌入处理区、写 turn.history → before / targeting / 逐目标 targeted / targetSpecified+targetConfirmed /
 * using → 逐目标 CardEffect(零目标 ⇒ 一个 target=null 的效果;轮到时已死亡的目标跳过)→ after → 残留牌入弃牌堆。
 * 任一可取消时机取消都会提前结束结算,但残留牌仍会进入弃牌堆(善后在正常流程里,不在 finally)。
 */
export function* onCardUse(ctx: Ctx, ev: CardUseEvent): Flow<void> {
  const def = ctx.registry.card(ev.card.name)
  if (def === null) throw new EngineError(`牌 ${ev.card.name} 未注册,不能使用`)
  if (ev.card.subcards.length > 0) {
    yield* moveCards(
      ctx,
      ev.card.subcards.map((card) => ({
        card,
        to: { kind: 'processing' as const },
        reason: 'use' as const,
      })),
    )
  }
  const turn = ctx.state.turn
  if (turn !== null) {
    turn.history.push({
      player: ev.source,
      card: ev.card.name,
      mode: 'use',
      reason: ev.reason,
      phase: turn.phase,
    })
  }
  ctx.log({
    type: 'useCard',
    data: {
      source: ev.source,
      card: faceToJson(ev.card),
      targets: [...ev.targets],
      reason: ev.reason,
    },
    visibleTo: null,
    eventId: ev.id,
  })
  yield* cardUseMain(ctx, ev, def)
  const residual = ev.card.subcards.filter((c) => zoneOf(ctx.state, c).kind === 'processing')
  if (residual.length > 0) {
    yield* moveCards(
      ctx,
      residual.map((card) => ({ card, to: { kind: 'discard' as const }, reason: 'use' as const })),
    )
  }
}

function* cardUseMain(ctx: Ctx, ev: CardUseEvent, def: CardDef): Flow<void> {
  if (!(yield* stage(ctx, 'CardUse.before', ev))) return
  if (!(yield* stage(ctx, 'CardUse.targeting', ev))) return
  for (const t of orderTargets(ctx.state, ev.source, ev.targets)) {
    ev.currentTarget = t
    yield* stage(ctx, 'CardUse.targeted', ev)
  }
  for (const t of orderTargets(ctx.state, ev.source, ev.targets)) {
    ev.currentTarget = t
    yield* stage(ctx, 'CardUse.targetSpecified', ev)
    yield* stage(ctx, 'CardUse.targetConfirmed', ev)
  }
  ev.currentTarget = null
  if (!(yield* stage(ctx, 'CardUse.using', ev))) return
  const targets: Array<PlayerId | null> =
    ev.targets.length === 0 ? [null] : orderTargets(ctx.state, ev.source, ev.targets)
  for (const target of targets) {
    if (target !== null && !playerOf(ctx, target).alive) continue
    yield* runEvent(ctx, {
      kind: 'CardEffect',
      useId: ev.id,
      card: ev.card,
      source: ev.source,
      target,
      delayed: false,
      nullifiable: def.type === 'delayed_trick' ? false : ev.nullifiable,
      nullified: false,
      voided: false,
      responded: false,
      requiredResponses:
        target === null
          ? 0
          : (ev.responseCounts[String(target)] ?? fold(ctx, 'requiredResponses', 1, ev, target)),
    })
  }
  yield* stage(ctx, 'CardUse.after', ev)
}

/** CardRespond(打出):牌入处理区、写 turn.history → CardRespond.before → CardRespond.after → 残留牌入弃牌堆;不产生 CardEffect */
export function* onCardRespond(ctx: Ctx, ev: CardRespondEvent): Flow<void> {
  if (ev.card.subcards.length > 0) {
    yield* moveCards(
      ctx,
      ev.card.subcards.map((card) => ({
        card,
        to: { kind: 'processing' as const },
        reason: 'respond' as const,
      })),
    )
  }
  const turn = ctx.state.turn
  if (turn !== null) {
    turn.history.push({
      player: ev.player,
      card: ev.card.name,
      mode: 'play',
      reason: 'response',
      phase: turn.phase,
    })
  }
  ctx.log({
    type: 'respondCard',
    data: { player: ev.player, card: faceToJson(ev.card), against: ev.againstId },
    visibleTo: null,
    eventId: ev.id,
  })
  if (yield* stage(ctx, 'CardRespond.before', ev)) yield* stage(ctx, 'CardRespond.after', ev)
  const residual = ev.card.subcards.filter((c) => zoneOf(ctx.state, c).kind === 'processing')
  if (residual.length > 0) {
    yield* moveCards(
      ctx,
      residual.map((card) => ({
        card,
        to: { kind: 'discard' as const },
        reason: 'respond' as const,
      })),
    )
  }
}

/**
 * CardEffect:[nullifiable ⇒ 无懈链] → [nullifyEffect 折叠(仁王盾)] → 若无效:CardEffect.nullified + onNullified 并返回
 * → CardEffect.before → def.effect → CardEffect.after。单目标单效果(D5)。
 */
export function* onCardEffect(ctx: Ctx, ev: CardEffectEvent): Flow<void> {
  const def = ctx.registry.card(ev.card.name)
  if (def === null) throw new EngineError(`牌 ${ev.card.name} 未注册,不能生效`)
  if (ev.nullifiable) yield* resolveNullification(ctx, ev)
  if (!ev.nullified && ev.target !== null && fold(ctx, 'nullifyEffect', false, ev)) ev.voided = true
  if (ev.nullified || ev.voided) {
    ctx.log({
      type: ev.nullified ? 'nullified' : 'effectVoid',
      data: { card: faceToJson(ev.card), target: ev.target },
      visibleTo: null,
      eventId: ev.id,
    })
    yield* stage(ctx, 'CardEffect.nullified', ev)
    if (def.onNullified) yield* def.onNullified(ctx, ev)
    return
  }
  if (!(yield* stage(ctx, 'CardEffect.before', ev))) return
  if (def.effect) yield* def.effect(ctx, ev)
  yield* stage(ctx, 'CardEffect.after', ev)
}

/**
 * 无懈可击链:从当前回合玩家起逐个询问是否使用无懈;有人响应且原效果仍有效(无懈被反无懈)时,
 * 按 options.reopenNullification 决定是否再开放一轮。任意深度 = 递归(无懈的 CardUse 自己再走 CardEffect)。
 */
export function resolveNullification(ctx: Ctx, eff: CardEffectEvent): Flow<void> {
  return guardFlow(ctx, 'resolveNullification', () => resolveNullificationBody(ctx, eff))
}

function* resolveNullificationBody(ctx: Ctx, eff: CardEffectEvent): Flow<void> {
  for (;;) {
    let responded = false
    for (const p of playersFrom(ctx.state, anchor(ctx.state))) {
      if (!p.alive) continue
      const r = yield* askCard(ctx, {
        player: p.id,
        pattern: byName('nullification'),
        mode: 'use',
        targets: [],
        againstId: eff.id,
        reasonId: eff.id,
        prompt: {
          key: 'ask.nullification',
          args: { card: eff.card.name, target: eff.target ?? -1 },
        },
      })
      if (r.responded) {
        responded = true
        break
      }
    }
    if (!responded || eff.nullified || !ctx.options.reopenNullification) return
  }
}
