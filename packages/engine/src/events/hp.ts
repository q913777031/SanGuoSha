/**
 * events/hp.ts ─ 体力相关事件:Damage、LoseHp、Recover、Dying、Death(§12a)。
 * 濒死在"受到伤害后"之前结算;胜负判定先于死亡奖惩与弃置全部牌。
 */
import { gameOver, runEvent, stage } from '../core/engine.js'
import { askCard } from '../core/flow.js'
import { anchor, eventById, faceToJson, playerOf, playersFrom } from '../core/state.js'
import type {
  Ctx,
  DamageEvent,
  DeathEvent,
  DyingEvent,
  Flow,
  LoseHpEvent,
  RecoverEvent,
} from '../core/types.js'
import { allCardsOf, moveCards } from '../core/zones.js'
import { byName } from '../cards/pattern.js'

/** Damage:[目标已死亡 ⇒ 取消] → Damage.caused → Damage.inflicted → 扣血 → [hp ≤ 0 ⇒ Dying] → Damage.done → Damage.after */
export function* onDamage(ctx: Ctx, ev: DamageEvent): Flow<void> {
  const victim = playerOf(ctx, ev.to)
  if (!victim.alive) {
    ev.cancelled = true
    return
  }
  if (!(yield* stage(ctx, 'Damage.caused', ev))) return
  if (!(yield* stage(ctx, 'Damage.inflicted', ev))) return
  if (ev.amount <= 0) return
  victim.hp -= ev.amount
  ctx.log({
    type: 'damage',
    data: {
      from: ev.from,
      to: ev.to,
      amount: ev.amount,
      nature: ev.nature,
      card: ev.card === null ? null : faceToJson(ev.card),
      hp: victim.hp,
    },
    visibleTo: null,
    eventId: ev.id,
  })
  if (victim.hp <= 0) yield* runEvent(ctx, { kind: 'Dying', player: ev.to, damageId: ev.id })
  yield* stage(ctx, 'Damage.done', ev)
  yield* stage(ctx, 'Damage.after', ev)
}

/** LoseHp:LoseHp.before → 扣血 → [hp ≤ 0 ⇒ Dying(damageId null)] → LoseHp.after */
export function* onLoseHp(ctx: Ctx, ev: LoseHpEvent): Flow<void> {
  const victim = playerOf(ctx, ev.player)
  if (!victim.alive) {
    ev.cancelled = true
    return
  }
  if (!(yield* stage(ctx, 'LoseHp.before', ev))) return
  if (ev.amount <= 0) return
  victim.hp -= ev.amount
  ctx.log({
    type: 'loseHp',
    data: { player: ev.player, amount: ev.amount, hp: victim.hp },
    visibleTo: null,
    eventId: ev.id,
  })
  if (victim.hp <= 0) yield* runEvent(ctx, { kind: 'Dying', player: ev.player, damageId: null })
  yield* stage(ctx, 'LoseHp.after', ev)
}

/** Recover:Recover.before(救援 +1)→ 回血(不超过 maxHp)→ Recover.after */
export function* onRecover(ctx: Ctx, ev: RecoverEvent): Flow<void> {
  const target = playerOf(ctx, ev.to)
  if (!target.alive) {
    ev.cancelled = true
    return
  }
  if (!(yield* stage(ctx, 'Recover.before', ev))) return
  if (ev.amount <= 0) return
  const before = target.hp
  target.hp = Math.min(target.maxHp, target.hp + ev.amount)
  ctx.log({
    type: 'recover',
    data: {
      to: ev.to,
      amount: target.hp - before,
      source: ev.source,
      card: ev.card === null ? null : faceToJson(ev.card),
      hp: target.hp,
    },
    visibleTo: null,
    eventId: ev.id,
  })
  yield* stage(ctx, 'Recover.after', ev)
}

/** Dying:Dying.enter → 从当前回合玩家起逐人求桃(同一人可连续出桃)→ Dying.after → [hp ≤ 0 ⇒ Death] */
export function* onDying(ctx: Ctx, ev: DyingEvent): Flow<void> {
  const victim = playerOf(ctx, ev.player)
  ctx.log({
    type: 'dying',
    data: { player: ev.player, hp: victim.hp },
    visibleTo: null,
    eventId: ev.id,
  })
  if (!(yield* stage(ctx, 'Dying.enter', ev))) return
  if (victim.hp <= 0) {
    for (const p of playersFrom(ctx.state, anchor(ctx.state))) {
      if (!p.alive) continue
      while (victim.hp <= 0 && victim.alive) {
        const r = yield* askCard(ctx, {
          player: p.id,
          pattern: byName('peach'),
          mode: 'use',
          targets: [victim.id],
          againstId: null,
          reasonId: ev.id,
          prompt: { key: 'ask.peach', args: { target: victim.id } },
        })
        if (!r.responded) break
      }
      if (victim.hp > 0) break
    }
  }
  yield* stage(ctx, 'Dying.after', ev)
  if (victim.hp <= 0 && victim.alive) {
    const dmg = ev.damageId === null ? null : eventById(ctx.state, ev.damageId)
    yield* runEvent(ctx, {
      kind: 'Death',
      player: victim.id,
      killer: dmg?.kind === 'Damage' ? dmg.from : null,
      damageId: ev.damageId,
    })
  }
}

/** Death:Death.before → 标记死亡 / 亮身份 → mode.checkWinner(胜负 ⇒ GameOver)→ Death.after → mode.onDeath → 弃置全部牌 */
export function* onDeath(ctx: Ctx, ev: DeathEvent): Flow<void> {
  yield* stage(ctx, 'Death.before', ev)
  const p = playerOf(ctx, ev.player)
  p.alive = false
  p.roleRevealed = true
  ctx.log({
    type: 'death',
    data: { player: p.id, role: p.role, killer: ev.killer },
    visibleTo: null,
    eventId: ev.id,
  })
  const mode = ctx.registry.mode(ctx.state.mode)
  const result = mode.checkWinner(ctx)
  if (result !== null) gameOver(ctx, result)
  yield* stage(ctx, 'Death.after', ev)
  yield* mode.onDeath(ctx, ev)
  const cards = allCardsOf(p)
  if (cards.length > 0) {
    yield* moveCards(
      ctx,
      cards.map((card) => ({ card, to: { kind: 'discard' as const }, reason: 'bury' as const })),
    )
  }
}
