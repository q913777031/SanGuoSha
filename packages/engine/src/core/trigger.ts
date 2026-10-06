/**
 * core/trigger.ts ─ 触发技的收集、排序与询问(D8 / §6)。
 * 顺序:优先级桶(降序)→ 从当前回合玩家起座位序 → 同玩家锁定技先、可选技由 invokeSkill 选 →
 * 每发动一次重扫 → times() 控制同事件多次触发 → 拒绝一次本时机不再问 → 事件取消即终止。
 */
import { ask, guardFlow } from './flow.js'
import type {
  Ctx,
  Flow,
  PlayerId,
  SkillDef,
  Timing,
  TimingEventMap,
  TriggerSkill,
} from './types.js'
import { EQUIP_SLOTS } from './types.js'

/**
 * 玩家当前拥有的全部技能定义,顺序 = 数据声明序:
 * PlayerState.skills(武将声明序 + 后天获得)→ 装备按 EQUIP_SLOTS 槽序各自的 equip.skills。
 * 主公技只在 mode.lordSkillsEnabled 为真时参与。
 */
export function skillsOf(ctx: Ctx, player: PlayerId): SkillDef[] {
  const p = ctx.state.players[player]
  if (p === undefined) return []
  const mode = ctx.registry.mode(ctx.state.mode)
  const lordEnabled = mode.lordSkillsEnabled(ctx, player)
  const result: SkillDef[] = []
  const push = (id: string): void => {
    const skill = ctx.registry.skill(id)
    if (skill.lord && !lordEnabled) return
    result.push(skill)
  }
  for (const id of p.skills) push(id)
  for (const slot of EQUIP_SLOTS) {
    const card = p.equips[slot]
    if (card === null) continue
    const def = ctx.registry.card(ctx.registry.spec(card).name)
    if (def?.equip) for (const id of def.equip.skills) push(id)
  }
  return result
}

const key = (player: PlayerId, skill: string): string => `${player}:${skill}`

/** 在某时机点依次询问 / 发动全部符合条件的触发技;事件被取消即提前返回 */
export function trigger<T extends Timing>(ctx: Ctx, timing: T, ev: TimingEventMap[T]): Flow<void> {
  return guardFlow(ctx, `trigger:${timing}`, () => triggerBody(ctx, timing, ev))
}

function* triggerBody<T extends Timing>(ctx: Ctx, timing: T, ev: TimingEventMap[T]): Flow<void> {
  if (ctx.registry.triggerSkillsAt(timing).length === 0) return
  const fired: Record<string, number> = {}
  const declined = new Set<string>()
  const start = ctx.state.turn === null ? 0 : ctx.state.turn.player
  const n = ctx.state.players.length
  for (const prio of ctx.registry.triggerPriorities(timing)) {
    scan: for (;;) {
      for (let i = 0; i < n; i++) {
        const p = ctx.state.players[(start + i) % n]
        if (p === undefined) continue
        const cands = skillsOf(ctx, p.id).filter(
          (s): s is TriggerSkill =>
            s.type === 'trigger' &&
            s.priority === prio &&
            (s.timings as readonly string[]).includes(timing) &&
            (p.alive || s.triggerWhenDead) &&
            !declined.has(key(p.id, s.id)) &&
            (fired[key(p.id, s.id)] ?? 0) < (s.times?.(ctx, ev, p.id) ?? 1) &&
            s.canTrigger(ctx, ev, p.id),
        )
        if (cands.length === 0) continue
        const locked = cands.filter((s) => s.locked)
        let chosen: TriggerSkill | null
        if (locked.length > 0) {
          chosen = locked[0] ?? null
        } else {
          const r = yield* ask(ctx, {
            kind: 'invokeSkill',
            player: p.id,
            skills: cands.map((s) => s.id),
            event: ev.id,
            reason: ev.id,
            prompt: { key: 'invokeSkill', args: { timing, event: ev.kind } },
          })
          chosen = r.skill === null ? null : (cands.find((s) => s.id === r.skill) ?? null)
        }
        if (chosen === null) {
          for (const s of cands) declined.add(key(p.id, s.id))
          continue
        }
        fired[key(p.id, chosen.id)] = (fired[key(p.id, chosen.id)] ?? 0) + 1
        ctx.log({
          type: 'skillInvoked',
          data: { player: p.id, skill: chosen.id, eventId: ev.id, timing },
          visibleTo: null,
          eventId: ev.id,
        })
        yield* chosen.effect(ctx, ev, p.id)
        if (ev.cancelled) return
        continue scan
      }
      break
    }
  }
}
