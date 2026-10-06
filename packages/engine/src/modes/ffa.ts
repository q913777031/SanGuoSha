/**
 * modes/ffa.ts ─ M1 模式:无身份混战,最后存活者胜。
 * setup:分配占位武将(config 指定则用指定)、hp = maxHp、洗牌或 fixedDeckOrder、每人发 4 张初始手牌。
 */
import { runEvent } from '../core/engine.js'
import type { ModeDef } from '../core/types.js'
import { initializeDrawPile } from '../core/zones.js'
import { PLACEHOLDER_GENERAL_ID } from '../generals/placeholder.js'

/** 初始手牌数 */
export const INITIAL_HAND_SIZE = 4

/** 无身份混战模式定义 */
export const ffa: ModeDef = {
  id: 'ffa',
  playerCount: [2, 8],
  *setup(ctx) {
    const s = ctx.state
    for (const p of s.players) {
      const generalId = ctx.config.players[p.id]?.general ?? PLACEHOLDER_GENERAL_ID
      const general = ctx.registry.general(generalId)
      p.general = general.id
      p.kingdom = general.kingdom
      p.gender = general.gender
      p.maxHp = general.maxHp
      p.hp = general.maxHp
      p.alive = true
      p.role = 'none'
      p.roleRevealed = true
      p.skills = [...general.skills]
    }
    initializeDrawPile(ctx)
    for (const p of s.players) {
      yield* runEvent(ctx, {
        kind: 'DrawCards',
        player: p.id,
        count: INITIAL_HAND_SIZE,
        reason: 'initial',
        cards: [],
      })
    }
  },
  *onDeath() {},
  checkWinner(ctx) {
    const alive = ctx.state.players.filter((p) => p.alive).map((p) => p.id)
    return alive.length <= 1 ? { winners: alive, reason: 'lastSurvivor' } : null
  },
  roleVisible: () => true,
  lordSkillsEnabled: () => false,
}
