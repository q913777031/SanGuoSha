/**
 * core/rng.ts ─ mulberry32 伪随机数。
 * 状态是一个 uint32,存放在 GameState.rng;每次取数返回新状态,由调用方写回。
 * 引擎内唯一的随机源是 Ctx.random / randomInt / shuffle(实现见 engine.ts),
 * 控制器(随机 AI)用 deriveSeed(seed, player) 派生独立状态,与引擎 RNG 隔离。
 */

/** 把任意整数种子规范为 uint32 的 RNG 初始状态(含一次搅拌,避免相邻种子的首值相关) */
export function seedRng(seed: number): number {
  let s = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0
  s = Math.imul(s ^ (s >>> 16), 0x85ebca6b) >>> 0
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35) >>> 0
  return (s ^ (s >>> 16)) >>> 0
}

/** 由 (seed, salt) 派生一个独立的子种子:控制器 / 测试用,保证与引擎 RNG 不相关 */
export function deriveSeed(seed: number, salt: number): number {
  return seedRng((seedRng(seed) + Math.imul(Math.trunc(salt) + 1, 0x7f4a7c15)) >>> 0)
}

/** 取下一个 [0, 1) 的浮点数;返回 [值, 新状态] */
export function nextRandom(state: number): [value: number, next: number] {
  const next = (state + 0x6d2b79f5) >>> 0
  let t = next | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296
  return [value, next]
}

/** 取 [0, n) 的整数(n ≤ 0 时恒为 0);返回 [值, 新状态] */
export function nextInt(state: number, n: number): [value: number, next: number] {
  if (n <= 0) return [0, state]
  const [value, next] = nextRandom(state)
  return [Math.floor(value * n), next]
}

/** Fisher–Yates 原地洗牌;返回新状态 */
export function shuffleInPlace<T>(state: number, items: T[]): number {
  let s = state
  for (let i = items.length - 1; i > 0; i--) {
    const [j, next] = nextInt(s, i + 1)
    s = next
    const a = items[i] as T
    items[i] = items[j] as T
    items[j] = a
  }
  return s
}
