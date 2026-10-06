/**
 * core/modifiers.ts ─ 修正技折叠(D7 / §7)。
 * fold() 按座位 0 起、再按 skillsOf 顺序,把所有玩家(含装备)的修正钩子依次作用在基值上;纯函数、不询问。
 */
import { skillsOf } from './trigger.js'
import type { Ctx, HookArgs, HookValue, ModifierHook, ModifierKey } from './types.js'

/** 对 hook 的基值做一次全场折叠:固定且确定的顺序,钩子应写成与顺序无关 */
export function fold<K extends ModifierKey>(
  ctx: Ctx,
  hook: K,
  base: HookValue<K>,
  ...args: HookArgs<K>
): HookValue<K> {
  let value = base
  for (const p of ctx.state.players) {
    for (const s of skillsOf(ctx, p.id)) {
      if (s.type !== 'modifier') continue
      const h = s.modifiers[hook] as ModifierHook<HookValue<K>, HookArgs<K>> | undefined
      if (h) value = h(ctx, p.id, value, ...args)
    }
  }
  return value
}
