/**
 * timings.snapshot.test.ts ─ 锁住 §3.2 的时机触发顺序。
 * 0 号位挂载订阅全部时机的记录型锁定技,把 `${timing}:${kind}` 依次记下;
 * 两类固定脚本(完整空回合;杀→闪 / 杀→濒死→桃 / 杀→死亡)的序列用 toMatchSnapshot 锁住,
 * 另用 toEqual 显式断言 CardUse 与 Damage 的时机顺序。
 */
import { describe, expect, it } from 'vitest'

import type { CardId, CardName, Game, Registry } from '../src/index.js'
import { EngineError } from '../src/index.js'
import type { PlayerSpec } from '../src/testing/index.js'
import {
  answer,
  buildGame,
  createTestRegistry,
  expectRequest,
  recordingSkills,
} from '../src/testing/index.js'

/** 记录夹具:注册表、全部记录技能 id、`${timing}:${kind}` 序列 */
interface Recorder {
  registry: Registry
  skillIds: string[]
  records: string[]
}

/** 构造带记录技能的注册表;夹具原始格式 `${timing} ${kind}#${id}` 在读取时转为 `${timing}:${kind}` */
function recorder(): Recorder {
  const { skills, records } = recordingSkills('rec')
  const registry = createTestRegistry({ name: 'test-timings', version: '0.0.0', skills })
  return { registry, skillIds: skills.map((s) => s.id), records }
}

/** 把夹具记录转为 `${timing}:${kind}` */
function seq(records: readonly string[]): string[] {
  return records.map((r) => {
    const m = /^(\S+) (\w+)#\d+$/.exec(r)
    if (m === null) throw new EngineError(`无法解析记录:${r}`)
    return `${m[1]}:${m[2]}`
  })
}

/** 只保留给定事件种类的记录 */
function only(records: readonly string[], kinds: readonly string[]): string[] {
  return records.filter((r) => kinds.includes(r.slice(r.indexOf(':') + 1)))
}

/** 牌表中第 nth 张名为 name 的牌 id */
function card(registry: Registry, name: CardName, nth = 0): CardId {
  const id = registry.deck.filter((c) => c.name === name)[nth]?.id
  if (id === undefined) throw new EngineError(`牌表中没有第 ${nth} 张 ${name}`)
  return id
}

/** 0 号位挂载全部记录技能后建局并 start(固定 seed);摸牌阶段摸到的两张固定为杀,不影响求闪 / 求桃 */
function start(rec: Recorder, players: PlayerSpec[]): Game {
  const [first, ...rest] = players
  const game = buildGame(rec.registry, {
    seed: 7,
    players: [{ ...first, skills: rec.skillIds }, ...rest],
    drawPileTop: [card(rec.registry, 'slash', 1), card(rec.registry, 'slash', 2)],
  })
  game.start()
  return game
}

/** 0 号位在出牌阶段对 1 号位使用杀,并从此刻开始记录 */
function useSlash(rec: Recorder, game: Game, slash: CardId): void {
  expectRequest(game, 'play')
  rec.records.length = 0
  answer(game, { action: 'useCard', card: slash, targets: [1] })
}

/** 单目标杀的 CardUse 前半段(到 using 为止) */
const SLASH_USE_HEAD = [
  'CardUse.before:CardUse',
  'CardUse.targeting:CardUse',
  'CardUse.targeted:CardUse',
  'CardUse.targetSpecified:CardUse',
  'CardUse.targetConfirmed:CardUse',
  'CardUse.using:CardUse',
]

describe('时机顺序快照', () => {
  it('完整一个回合无出牌:0 号位回合开始到 1 号位出牌阶段', () => {
    const rec = recorder()
    const game = start(rec, [{}, {}])
    answer(game, { action: 'end' })
    expect(expectRequest(game, 'play').player).toBe(1)
    const records = seq(rec.records)
    expect(records).toMatchSnapshot()
    expect(only(records, ['Turn']).slice(0, 2)).toEqual(['Turn.start:Turn', 'Turn.end:Turn'])
  })

  it('杀 → 闪:无伤害', () => {
    const rec = recorder()
    const slash = card(rec.registry, 'slash')
    const jink = card(rec.registry, 'jink')
    const game = start(rec, [{ hand: [slash] }, { hand: [jink] }, {}])
    useSlash(rec, game, slash)
    answer(game, { card: jink, viewAs: null, targets: [] })
    expectRequest(game, 'play')
    const records = seq(rec.records)
    expect(records).toMatchSnapshot()
    expect(only(records, ['CardUse', 'Damage'])).toEqual([
      ...SLASH_USE_HEAD,
      'CardUse.before:CardUse',
      'CardUse.targeting:CardUse',
      'CardUse.using:CardUse',
      'CardUse.after:CardUse',
      'CardUse.after:CardUse',
    ])
  })

  it('杀 → 伤害 → 濒死 → 桃:受伤者自救', () => {
    const rec = recorder()
    const slash = card(rec.registry, 'slash')
    const peach = card(rec.registry, 'peach')
    const game = start(rec, [{ hand: [slash] }, { hand: [peach], hp: 1 }, {}])
    useSlash(rec, game, slash)
    expect(expectRequest(game, 'askCard').player).toBe(1)
    answer(game, { card: peach, viewAs: null, targets: [] })
    expectRequest(game, 'play')
    expect(game.state.players[1]).toMatchObject({ hp: 1, alive: true })
    const records = seq(rec.records)
    expect(records).toMatchSnapshot()
    expect(only(records, ['CardUse', 'Damage', 'Dying', 'Recover'])).toEqual([
      ...SLASH_USE_HEAD,
      'Damage.caused:Damage',
      'Damage.inflicted:Damage',
      'Dying.enter:Dying',
      ...SLASH_USE_HEAD,
      'Recover.before:Recover',
      'Recover.after:Recover',
      'CardUse.after:CardUse',
      'Dying.after:Dying',
      'Damage.done:Damage',
      'Damage.after:Damage',
      'CardUse.after:CardUse',
    ])
  })

  it('杀 → 死亡:无人出桃,对局继续', () => {
    const rec = recorder()
    const slash = card(rec.registry, 'slash')
    const game = start(rec, [{ hand: [slash] }, { hp: 1 }, {}])
    useSlash(rec, game, slash)
    expectRequest(game, 'play')
    expect(game.state.players[1]?.alive).toBe(false)
    const records = seq(rec.records)
    expect(records).toMatchSnapshot()
    expect(only(records, ['CardUse', 'CardEffect', 'Damage', 'Dying', 'Death'])).toEqual([
      ...SLASH_USE_HEAD,
      'CardEffect.before:CardEffect',
      'Damage.caused:Damage',
      'Damage.inflicted:Damage',
      'Dying.enter:Dying',
      'Dying.after:Dying',
      'Death.before:Death',
      'Death.after:Death',
      'Damage.done:Damage',
      'Damage.after:Damage',
      'CardEffect.after:CardEffect',
      'CardUse.after:CardUse',
    ])
  })
})
