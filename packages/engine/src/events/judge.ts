/**
 * events/judge.ts ─ 判定事件与改判原子动作(§12c)。M1 实现 handler,M2 乐 / 闪电 / 八卦阵直接使用。
 */
import { EngineError, stage } from '../core/engine.js'
import { guardFlow } from '../core/flow.js'
import type { CardId, Ctx, Flow, JudgeEvent, PlayerId } from '../core/types.js'
import { moveCards, peekDrawPile, zoneOf } from '../core/zones.js'
import { matchPattern } from '../cards/pattern.js'

/** Judge:Judge.before → 翻牌堆顶入处理区 → Judge.cardShown(改判)→ 算 matched → Judge.result → Judge.after → 判定牌若仍在处理区则入弃牌堆 */
export function* onJudge(ctx: Ctx, ev: JudgeEvent): Flow<void> {
  yield* stage(ctx, 'Judge.before', ev)
  const [card] = yield* peekDrawPile(ctx, 1)
  if (card === undefined) throw new EngineError('牌堆顶为空,无法判定')
  yield* moveCards(ctx, [{ card, to: { kind: 'processing' }, reason: 'judge' }])
  ev.card = card
  yield* stage(ctx, 'Judge.cardShown', ev)
  if (ev.card === null) throw new EngineError('判定牌丢失')
  ev.matched = matchPattern(ctx.registry.spec(ev.card), ev.pattern)
  ctx.log({
    type: 'judge',
    data: { player: ev.player, reason: ev.reason, card: ev.card, matched: ev.matched },
    visibleTo: null,
    eventId: ev.id,
  })
  yield* stage(ctx, 'Judge.result', ev)
  yield* stage(ctx, 'Judge.after', ev)
  if (zoneOf(ctx.state, ev.card).kind === 'processing') {
    yield* moveCards(ctx, [{ card: ev.card, to: { kind: 'discard' }, reason: 'judge' }])
  }
}

/** 改判原子动作:新牌入处理区、旧判定牌入弃牌堆或改判者手牌(takeOld);不走"打出" */
export function retrial(
  ctx: Ctx,
  judge: JudgeEvent,
  newCard: CardId,
  by: PlayerId,
  takeOld: boolean,
): Flow<void> {
  return guardFlow(ctx, 'retrial', () => retrialBody(ctx, judge, newCard, by, takeOld))
}

function* retrialBody(
  ctx: Ctx,
  judge: JudgeEvent,
  newCard: CardId,
  by: PlayerId,
  takeOld: boolean,
): Flow<void> {
  const old = judge.card
  if (old === null) throw new EngineError('尚未翻出判定牌,不能改判')
  yield* moveCards(ctx, [{ card: newCard, to: { kind: 'processing' }, reason: 'retrial' }])
  yield* moveCards(ctx, [
    {
      card: old,
      to: takeOld ? { kind: 'hand', player: by } : { kind: 'discard' },
      reason: 'retrial',
    },
  ])
  judge.card = newCard
  judge.retrialBy.push(by)
  ctx.log({
    type: 'retrial',
    data: { player: judge.player, by, oldCard: old, newCard },
    visibleTo: null,
    eventId: judge.id,
  })
}
