/**
 * cards/basic.ts ─ M1 三张基本牌:杀 / 闪 / 桃(§10.2)。
 */
import { runEvent } from '../core/engine.js'
import { askCard } from '../core/flow.js'
import { playerOf, usedInPlay, useLimit } from '../core/state.js'
import type { CardDef } from '../core/types.js'
import { byName } from './pattern.js'

/** 杀:攻击范围内一名其他角色;目标需出闪(requiredResponses 张)否则受到 1 点普通伤害;出牌阶段限 useLimit 次 */
export const slash: CardDef = {
  name: 'slash',
  type: 'basic',
  equip: null,
  judgePattern: null,
  nullifiable: false,
  target: { min: 1, max: 1, auto: null, range: 'attack', excludeSelf: true },
  canUse: (ctx, user, card) => usedInPlay(ctx, user, 'slash') < useLimit(ctx, user, card),
  *effect(ctx, eff) {
    const target = eff.target
    if (target === null) return
    let dodged = eff.requiredResponses > 0
    for (let i = 0; i < eff.requiredResponses; i++) {
      const r = yield* askCard(ctx, {
        player: target,
        pattern: byName('jink'),
        mode: 'use',
        targets: [],
        againstId: eff.id,
        reasonId: eff.id,
        prompt: { key: 'ask.jink', args: { source: eff.source ?? -1 } },
      })
      if (!r.responded) {
        dodged = false
        break
      }
    }
    if (dodged) {
      eff.responded = true
      return
    }
    yield* runEvent(ctx, {
      kind: 'Damage',
      from: eff.source,
      to: target,
      amount: 1,
      nature: 'normal',
      card: eff.card,
      causeId: eff.id,
    })
  },
}

/** 闪:仅作响应(抵消杀);不能主动使用,无效果 */
export const jink: CardDef = {
  name: 'jink',
  type: 'basic',
  equip: null,
  judgePattern: null,
  nullifiable: false,
  target: { min: 0, max: 0, auto: null, range: null, excludeSelf: false },
  canUse: () => false,
}

/** 桃:体力未满时对自己使用回复 1 点;濒死时由任意角色对濒死者使用(AskCard.targets 优先于 auto: 'self') */
export const peach: CardDef = {
  name: 'peach',
  type: 'basic',
  equip: null,
  judgePattern: null,
  nullifiable: false,
  target: { min: 0, max: 0, auto: 'self', range: null, excludeSelf: false },
  canUse: (ctx, user) => playerOf(ctx, user).hp < playerOf(ctx, user).maxHp,
  *effect(ctx, eff) {
    if (eff.target === null) return
    yield* runEvent(ctx, {
      kind: 'Recover',
      to: eff.target,
      amount: 1,
      source: eff.source,
      card: eff.card,
      causeId: eff.id,
    })
  },
}
