/**
 * rng.test.ts ─ core/rng.ts(mulberry32)与 Ctx 随机源的确定性测试:
 * 种子可复现、randomInt 范围、shuffle 为置换、分布粗检、派生种子隔离、Game 开局洗牌只依赖 seed。
 */
import { describe, expect, it } from 'vitest'

import type { GameConfig, GameState } from '../src/index.js'
import {
  Game,
  INITIAL_HAND_SIZE,
  createInitialState,
  createStandardRegistry,
  deriveSeed,
  nextInt,
  nextRandom,
  seedRng,
  shuffleInPlace,
} from '../src/index.js'

/** 从给定状态连续取 n 个浮点数(纯函数,不改外部状态) */
function sequence(state: number, n: number): number[] {
  const out: number[] = []
  let s = state
  for (let i = 0; i < n; i++) {
    const [value, next] = nextRandom(s)
    out.push(value)
    s = next
  }
  return out
}

/** mulberry32 参考实现(与模块无关的独立写法),用于核对算法本身 */
function referenceMulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a | 0
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 判断 items 是否恰为 0..n-1 的一个置换 */
function isPermutation(items: readonly number[], n: number): boolean {
  if (items.length !== n) return false
  const seen = new Array<boolean>(n).fill(false)
  for (const x of items) {
    if (!Number.isInteger(x) || x < 0 || x >= n || seen[x]) return false
    seen[x] = true
  }
  return true
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

function configFor(seed: number, players = 5): GameConfig {
  return {
    seed,
    mode: 'ffa',
    players: Array.from({ length: players }, () => ({ general: null })),
    fixedDeckOrder: null,
    options: {
      assertInvariants: true,
      detectUnconsumedFlows: true,
      invalidResponsePolicy: 'throw',
    },
  }
}

describe('seedRng:种子规范化', () => {
  it('同一种子得到同一初始状态,且为 uint32', () => {
    for (const seed of [0, 1, 2, 42, 123456789, -7, 2 ** 31, 2 ** 32 + 5]) {
      const a = seedRng(seed)
      const b = seedRng(seed)
      expect(a).toBe(b)
      expect(Number.isInteger(a)).toBe(true)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('相邻种子的初始状态互不相同(搅拌生效)', () => {
    const states = range(200).map((seed) => seedRng(seed))
    expect(new Set(states).size).toBe(states.length)
  })

  it('非整数种子按截断处理:seedRng(3.9) === seedRng(3)', () => {
    expect(seedRng(3.9)).toBe(seedRng(3))
    expect(seedRng(-3.9)).toBe(seedRng(-3))
  })
})

describe('nextRandom:种子可复现', () => {
  it('同一状态连续取 1000 个数,两次序列完全相同', () => {
    const start = seedRng(2024)
    expect(sequence(start, 1000)).toEqual(sequence(start, 1000))
  })

  it('不同种子的序列不同', () => {
    const a = sequence(seedRng(1), 32)
    const b = sequence(seedRng(2), 32)
    expect(a).not.toEqual(b)
    // 并非只有首项不同:至少绝大多数位置都不同
    const differing = a.filter((v, i) => v !== b[i]).length
    expect(differing).toBeGreaterThan(28)
  })

  it('取值落在 [0, 1) 且每次调用状态都变化', () => {
    let s = seedRng(7)
    for (let i = 0; i < 1000; i++) {
      const [value, next] = nextRandom(s)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
      expect(next).not.toBe(s)
      expect(next).toBeGreaterThanOrEqual(0)
      expect(next).toBeLessThanOrEqual(0xffffffff)
      s = next
    }
  })

  it('是纯函数:传入同一状态多次调用不受先前调用影响', () => {
    const s = seedRng(99)
    const first = nextRandom(s)
    nextRandom(s)
    nextRandom(first[1])
    expect(nextRandom(s)).toEqual(first)
  })

  it('与 mulberry32 参考实现逐项一致(锁住算法,状态 = 参考实现内部计数器)', () => {
    for (const seed of [0, 1, 0xdeadbeef, 0xffffffff]) {
      const ref = referenceMulberry32(seed)
      let s = seed
      for (let i = 0; i < 64; i++) {
        const [value, next] = nextRandom(s)
        expect(value).toBe(ref())
        s = next
      }
    }
  })
})

describe('nextInt:范围与边界', () => {
  it('nextInt(n) 恒为 [0, n) 的整数', () => {
    for (const n of [1, 2, 3, 4, 7, 10, 108, 1000]) {
      let s = seedRng(n)
      for (let i = 0; i < 500; i++) {
        const [value, next] = nextInt(s, n)
        expect(Number.isInteger(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThan(n)
        s = next
      }
    }
  })

  it('n = 1 时恒为 0,但状态仍前进', () => {
    const s = seedRng(5)
    const [value, next] = nextInt(s, 1)
    expect(value).toBe(0)
    expect(next).toBe(nextRandom(s)[1])
  })

  it('n ≤ 0 时返回 0 且不消耗状态', () => {
    const s = seedRng(5)
    expect(nextInt(s, 0)).toEqual([0, s])
    expect(nextInt(s, -3)).toEqual([0, s])
  })

  it('同一状态同一 n 结果一致;两条独立链结果相同', () => {
    const a: number[] = []
    const b: number[] = []
    let sa = seedRng(31)
    let sb = seedRng(31)
    for (let i = 0; i < 200; i++) {
      const [va, na] = nextInt(sa, 6)
      const [vb, nb] = nextInt(sb, 6)
      a.push(va)
      b.push(vb)
      sa = na
      sb = nb
    }
    expect(a).toEqual(b)
    expect(sa).toBe(sb)
  })

  it('大范围内也能取到两端附近的值(不是只落在中间)', () => {
    let s = seedRng(11)
    let min = Number.MAX_SAFE_INTEGER
    let max = -1
    for (let i = 0; i < 5000; i++) {
      const [value, next] = nextInt(s, 1000)
      min = Math.min(min, value)
      max = Math.max(max, value)
      s = next
    }
    expect(min).toBeLessThan(10)
    expect(max).toBeGreaterThan(989)
  })
})

describe('nextInt 分布粗检', () => {
  it('10000 次 nextInt(4),每桶占比在 20%~30%', () => {
    const buckets = [0, 0, 0, 0]
    let s = seedRng(12345)
    for (let i = 0; i < 10000; i++) {
      const [value, next] = nextInt(s, 4)
      buckets[value] = (buckets[value] ?? 0) + 1
      s = next
    }
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(10000)
    for (const count of buckets) {
      expect(count).toBeGreaterThanOrEqual(2000)
      expect(count).toBeLessThanOrEqual(3000)
    }
  })

  it('换几个种子,10000 次 nextInt(4) 的每桶占比仍在 20%~30%', () => {
    for (const seed of [1, 2, 3, 2026]) {
      const buckets = [0, 0, 0, 0]
      let s = seedRng(seed)
      for (let i = 0; i < 10000; i++) {
        const [value, next] = nextInt(s, 4)
        buckets[value] = (buckets[value] ?? 0) + 1
        s = next
      }
      for (const count of buckets) {
        expect(count).toBeGreaterThanOrEqual(2000)
        expect(count).toBeLessThanOrEqual(3000)
      }
    }
  })

  it('10000 次 nextRandom 的均值接近 0.5', () => {
    const values = sequence(seedRng(777), 10000)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(mean).toBeGreaterThan(0.47)
    expect(mean).toBeLessThan(0.53)
  })
})

describe('shuffleInPlace:Fisher–Yates 洗牌', () => {
  it('洗牌结果是原数组的置换(108 张)', () => {
    const items = range(108)
    shuffleInPlace(seedRng(1), items)
    expect(isPermutation(items, 108)).toBe(true)
  })

  it('同 seed 两次洗牌结果与返回状态完全相同', () => {
    const a = range(108)
    const b = range(108)
    const sa = shuffleInPlace(seedRng(42), a)
    const sb = shuffleInPlace(seedRng(42), b)
    expect(a).toEqual(b)
    expect(sa).toBe(sb)
  })

  it('不同 seed 洗牌结果不同,且确实打乱了顺序', () => {
    const a = range(108)
    const b = range(108)
    shuffleInPlace(seedRng(1), a)
    shuffleInPlace(seedRng(2), b)
    expect(a).not.toEqual(b)
    expect(a).not.toEqual(range(108))
    expect(b).not.toEqual(range(108))
  })

  it('长度为 n 的数组恰消耗 n − 1 次随机数(状态可预测)', () => {
    const n = 20
    const items = range(n)
    const start = seedRng(9)
    const after = shuffleInPlace(start, items)
    let expected = start
    for (let i = 0; i < n - 1; i++) expected = nextRandom(expected)[1]
    expect(after).toBe(expected)
  })

  it('空数组与单元素数组不消耗状态、内容不变', () => {
    const s = seedRng(3)
    const empty: number[] = []
    const one = [7]
    expect(shuffleInPlace(s, empty)).toBe(s)
    expect(shuffleInPlace(s, one)).toBe(s)
    expect(empty).toEqual([])
    expect(one).toEqual([7])
  })

  it('洗牌不偏向某个位置:1000 次洗 4 个元素,元素 0 落在各位置的占比在 20%~30%', () => {
    const buckets = [0, 0, 0, 0]
    let s = seedRng(2468)
    for (let i = 0; i < 1000; i++) {
      const items = [0, 1, 2, 3]
      s = shuffleInPlace(s, items)
      const pos = items.indexOf(0)
      buckets[pos] = (buckets[pos] ?? 0) + 1
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThanOrEqual(200)
      expect(count).toBeLessThanOrEqual(300)
    }
  })
})

describe('deriveSeed:控制器随机源与引擎隔离', () => {
  it('同 (seed, salt) 派生结果一致,不同 salt 互不相同且不等于引擎初始状态', () => {
    const seed = 2024
    const engine = seedRng(seed)
    const derived = range(8).map((player) => deriveSeed(seed, player))
    expect(range(8).map((player) => deriveSeed(seed, player))).toEqual(derived)
    expect(new Set(derived).size).toBe(derived.length)
    for (const d of derived) expect(d).not.toBe(engine)
  })

  it('不同 seed 对同一 salt 派生出不同种子', () => {
    expect(deriveSeed(1, 0)).not.toBe(deriveSeed(2, 0))
    expect(deriveSeed(1, 3)).not.toBe(deriveSeed(2, 3))
  })

  it('派生种子的首段序列与引擎序列不同', () => {
    const seed = 55
    const engine = sequence(seedRng(seed), 16)
    for (let player = 0; player < 5; player++) {
      expect(sequence(deriveSeed(seed, player), 16)).not.toEqual(engine)
    }
  })
})

describe('Game:状态中的 rng 与开局洗牌', () => {
  const registry = createStandardRegistry()

  it('createInitialState 把 rng 初始化为 seedRng(seed),牌堆为全部牌 id 升序', () => {
    const state: GameState = createInitialState(configFor(17), registry)
    expect(state.seed).toBe(17)
    expect(state.rng).toBe(seedRng(17))
    expect(state.drawPile).toEqual(range(registry.deck.length))
  })

  it('开局洗牌 = shuffleInPlace(seedRng(seed), 全部牌):牌堆与初始手牌可由 seed 完全推出', () => {
    const seed = 2026
    const players = 5
    const game = new Game(configFor(seed, players), registry)
    const r = game.start()
    expect(r.type).toBe('request')

    const total = registry.deck.length
    const shuffled = range(total)
    const rngAfterShuffle = shuffleInPlace(seedRng(seed), shuffled)
    // 开局除洗牌外没有其他随机消耗(发牌按牌堆顶顺序)
    expect(game.state.rng).toBe(rngAfterShuffle)
    // 牌堆末尾 = 牌堆顶:每人依次从顶摸 INITIAL_HAND_SIZE 张,随后 0 号玩家首回合摸牌阶段再摸 2 张,
    // 然后停在出牌阶段的 play 请求(start 推进到第一个 Request)
    const expectedHands = range(players).map<number[]>(() => [])
    let top = total - 1
    for (let p = 0; p < players; p++) {
      for (let i = 0; i < INITIAL_HAND_SIZE; i++) expectedHands[p]?.push(shuffled[top--] as number)
    }
    for (let i = 0; i < 2; i++) expectedHands[0]?.push(shuffled[top--] as number)
    expect(game.state.drawPile).toEqual(shuffled.slice(0, top + 1))
    for (let p = 0; p < players; p++) {
      expect(game.state.players[p]?.hand).toEqual(expectedHands[p])
    }
  })

  it('同 seed 两局开局牌堆与手牌相同,不同 seed 不同', () => {
    const run = (seed: number) => {
      const game = new Game(configFor(seed), registry)
      game.start()
      return {
        drawPile: [...game.state.drawPile],
        hands: game.state.players.map((p) => [...p.hand]),
        rng: game.state.rng,
      }
    }
    expect(run(8)).toEqual(run(8))
    const a = run(8)
    const b = run(9)
    expect(a.drawPile).not.toEqual(b.drawPile)
    expect(a.rng).not.toBe(b.rng)
  })

  it('fixedDeckOrder 下不消耗随机数:rng 停留在 seedRng(seed)', () => {
    const total = registry.deck.length
    const config: GameConfig = { ...configFor(3), fixedDeckOrder: range(total) }
    const game = new Game(config, registry)
    game.start()
    expect(game.state.rng).toBe(seedRng(3))
    // 牌堆顶是 id 最大的牌,先发给 0 号玩家;0 号玩家首回合摸牌阶段再摸 2 张(全部发完后的牌堆顶)
    const dealt = game.state.players.length * INITIAL_HAND_SIZE
    expect(game.state.players[0]?.hand).toEqual([
      total - 1,
      total - 2,
      total - 3,
      total - 4,
      total - dealt - 1,
      total - dealt - 2,
    ])
  })

  it('开局后所有区域合起来仍是全部牌的置换', () => {
    const game = new Game(configFor(13), registry)
    game.start()
    const all = [...game.state.drawPile, ...game.state.players.flatMap((p) => p.hand)]
    expect(isPermutation(all, registry.deck.length)).toBe(true)
  })
})
