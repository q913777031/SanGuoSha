/**
 * turn.test.ts ─ 回合与阶段流程(设计 §3.2 / §3.3 / §12 回合结构)。
 * 覆盖:六阶段顺序;摸牌阶段摸 2;弃牌阶段超出手牌上限发 chooseCards(min = max = 超出数);
 *  skipPhases 跳过并触发 Phase.skipped;Phase.before 取消 = 跳过;Phase.start 取消 = 不执行正文与 Phase.end;
 *  @turn / @phase 标记自动清除而持久标记保留;回合玩家死亡后剩余阶段不执行;
 *  下一回合玩家为座位序下一存活者;turnQueue 优先;maxTurns 到达判平局。
 * 全部同步脚本式(Game.start / step),固定种子。
 */
import { describe, expect, it } from 'vitest'

import type {
  CardId,
  ContentPackage,
  Ctx,
  DrawCardsEvent,
  Flow,
  Game,
  PhaseEvent,
  PlayerId,
  SkillId,
  StepResult,
  Timing,
  TimingEventMap,
  TriggerSkill,
  TurnEvent,
} from '../src/index.js'
import { EngineError, PHASES, defaultResponse, runEvent } from '../src/index.js'
import type { PlayerSpec, StateSpec } from '../src/testing/index.js'
import { answer, buildGame, createTestRegistry, expectRequest } from '../src/testing/index.js'

/** 记录器订阅的时机 */
const RECORDED = [
  'Turn.start',
  'Turn.end',
  'Phase.before',
  'Phase.skipped',
  'Phase.start',
  'Phase.end',
  'DrawCards.after',
] as const satisfies readonly Timing[]
type RecordedTiming = (typeof RECORDED)[number]

/** 记录器的输出:由 recorder 技能在发动时追加 */
const records: string[] = []

/** 记录型锁定技:把 `p{玩家} {时机}[:阶段 / :摸牌数][ skipped]` 追加到 records(死亡后仍记录) */
function recorder<T extends RecordedTiming>(timing: T): TriggerSkill<T> {
  return {
    id: `rec:${timing}`,
    name: `rec:${timing}`,
    description: `记录 ${timing}`,
    type: 'trigger',
    timings: [timing],
    priority: 0,
    locked: true,
    lord: false,
    triggerWhenDead: true,
    canTrigger: () => true,
    *effect(_ctx, ev) {
      records.push(label(timing, ev))
      yield* []
    },
  }
}

function label(timing: Timing, ev: TurnEvent | PhaseEvent | DrawCardsEvent): string {
  const head = `p${ev.player} ${timing}`
  if (ev.kind === 'Phase') return `${head}:${ev.phase}${ev.skipped ? ' skipped' : ''}`
  if (ev.kind === 'DrawCards') return `${head}:${ev.count}`
  return head
}

/** 钩子技的描述:只在拥有者自己的 Turn / Phase 事件(且 phase 匹配时)发动 */
interface HookSpec<T extends 'Turn.start' | 'Phase.before' | 'Phase.start' | 'Phase.end'> {
  id: SkillId
  timing: T
  /** 仅对该阶段生效(Turn 时机忽略) */
  phase?: PhaseEvent['phase']
  onInvoke?: (ctx: Ctx, ev: TimingEventMap[T], owner: PlayerId) => void
  flow?: (ctx: Ctx, ev: TimingEventMap[T], owner: PlayerId) => Flow<void>
}

/** 构造测试用锁定钩子技 */
function hook<T extends 'Turn.start' | 'Phase.before' | 'Phase.start' | 'Phase.end'>(
  spec: HookSpec<T>,
): TriggerSkill<T> {
  const { onInvoke, flow } = spec
  return {
    id: spec.id,
    name: spec.id,
    description: `测试钩子 ${spec.id}`,
    type: 'trigger',
    timings: [spec.timing],
    priority: 1,
    locked: true,
    lord: false,
    triggerWhenDead: false,
    canTrigger: (_ctx, ev, owner) => {
      const e: TurnEvent | PhaseEvent = ev
      if (e.player !== owner) return false
      return e.kind === 'Turn' || spec.phase === undefined || e.phase === spec.phase
    },
    *effect(ctx, ev, owner) {
      onInvoke?.(ctx, ev, owner)
      if (flow !== undefined) yield* flow(ctx, ev, owner)
    },
  }
}

/** 当前回合状态(断言非空) */
function turnOf(ctx: Ctx): NonNullable<Ctx['state']['turn']> {
  const t = ctx.state.turn
  if (t === null) throw new EngineError('测试钩子必须在回合内发动')
  return t
}

const HOOKS = [
  hook({
    id: 'skip-draw-play',
    timing: 'Turn.start',
    onInvoke: (ctx) => turnOf(ctx).skipPhases.push('draw', 'play'),
  }),
  hook({
    id: 'cancel-before-draw',
    timing: 'Phase.before',
    phase: 'draw',
    onInvoke: (_ctx, ev) => {
      ev.cancelled = true
    },
  }),
  hook({
    id: 'cancel-start-draw',
    timing: 'Phase.start',
    phase: 'draw',
    onInvoke: (_ctx, ev) => {
      ev.cancelled = true
    },
  }),
  hook({
    id: 'set-marks',
    timing: 'Phase.start',
    phase: 'prepare',
    onInvoke: (ctx, _ev, owner) => {
      const p = ctx.state.players[owner]
      if (p === undefined) throw new EngineError(`玩家 ${owner} 不存在`)
      p.flags['f@phase'] = true
      p.flags['f@turn'] = true
      p.flags['f'] = true
      p.marks['m@phase'] = 1
      p.marks['m@turn'] = 2
      p.marks['m'] = 3
      ctx.state.flags['g@turn'] = 1
      ctx.state.flags['g'] = 1
      turnOf(ctx).counters['c@phase'] = 1
      turnOf(ctx).counters['c@turn'] = 1
    },
  }),
  hook({
    id: 'probe-judge',
    timing: 'Phase.start',
    phase: 'judge',
    onInvoke: (ctx, _ev, owner) => {
      const p = ctx.state.players[owner]
      if (p === undefined) throw new EngineError(`玩家 ${owner} 不存在`)
      const keys = [...Object.keys(p.flags), ...Object.keys(p.marks)].sort()
      records.push(`judge 时标记:${keys.join(',')}`)
    },
  }),
  hook({
    id: 'lose-hp-after-draw',
    timing: 'Phase.end',
    phase: 'draw',
    *flow(ctx, _ev, owner) {
      yield* runEvent(ctx, { kind: 'LoseHp', player: owner, amount: 1, reasonId: null })
    },
  }),
] as const

const testPackage: ContentPackage = {
  name: 'test-turn',
  version: '0.0.0',
  skills: [...RECORDED.map((t) => recorder(t)), ...HOOKS],
  generals: [],
  cards: [],
}
const registry = createTestRegistry(testPackage)
const REC_SKILLS: SkillId[] = RECORDED.map((t) => `rec:${t}`)

/** 构局:清空记录;observer 号玩家(默认 0)携带全部记录器 */
function setup(spec: StateSpec, options: Parameters<typeof buildGame>[2] = {}): Game {
  records.length = 0
  return buildGame(registry, { seed: 7, ...spec }, options)
}

/** n 名无手牌的占位玩家;overrides 按座位覆盖 */
function players(n: number, overrides: Record<number, PlayerSpec> = {}): PlayerSpec[] {
  return Array.from({ length: n }, (_, i) => overrides[i] ?? {})
}

/** 推进到下一个 play 请求:途中的其他请求一律给默认应答;返回 play 请求的玩家 */
function toNextPlay(game: Game, r: StepResult): PlayerId {
  let cur = r
  while (cur.type === 'request' && cur.request.kind !== 'play') {
    cur = game.step(defaultResponse(cur.request))
  }
  if (cur.type !== 'request') throw new EngineError('对局在到达 play 请求前结束')
  return cur.request.player
}

/** 结束当前出牌阶段并推进到下一个 play 请求 */
function endPlay(game: Game): PlayerId {
  return toNextPlay(game, answer(game, { action: 'end' }))
}

const p0Records = (): string[] => records.filter((r) => r.startsWith('p0 '))

describe('回合与阶段流程', () => {
  it('六阶段按 prepare→judge→draw→play→discard→finish 顺序,时机顺序为 before→start→正文→end', () => {
    const game = setup({ players: players(2, { 0: { skills: REC_SKILLS } }) })
    expect(toNextPlay(game, game.start())).toBe(0)
    expect(endPlay(game)).toBe(1)
    const expected = ['p0 Turn.start']
    for (const phase of PHASES) {
      expected.push(`p0 Phase.before:${phase}`, `p0 Phase.start:${phase}`)
      if (phase === 'draw') expected.push('p0 DrawCards.after:2')
      expected.push(`p0 Phase.end:${phase}`)
    }
    expected.push('p0 Turn.end')
    expect(p0Records()).toEqual(expected)
    const phaseLogs = game.log
      .filter((e) => e.type === 'phase')
      .map((e) => (e.data as { player: number; phase: string }).phase)
    expect(phaseLogs.slice(0, 6)).toEqual([...PHASES])
    expect(game.state.lastTurnPlayer).toBe(0)
    expect(game.state.turn?.player).toBe(1)
  })

  it('摸牌阶段从牌堆顶摸 2 张', () => {
    const top: CardId[] = [10, 11, 12]
    const game = setup({ players: players(2, { 0: { hand: [5] } }), drawPileTop: top })
    toNextPlay(game, game.start())
    expect([...(game.state.players[0]?.hand ?? [])].sort((a, b) => a - b)).toEqual([5, 10, 11])
    expect(game.state.drawPile[game.state.drawPile.length - 1]).toBe(12)
  })

  it('弃牌阶段手牌超过体力时发 chooseCards,min = max = 超出数,弃置所选牌', () => {
    const game = setup({ players: players(2, { 0: { hp: 2, hand: [1, 2, 3] } }) })
    toNextPlay(game, game.start())
    answer(game, { action: 'end' })
    const req = expectRequest(game, 'chooseCards')
    expect(req.player).toBe(0)
    expect(req.min).toBe(3)
    expect(req.max).toBe(3)
    expect(req.cancellable).toBe(false)
    expect(req.candidates).toHaveLength(5)
    const chosen = req.candidates.slice(0, 3).map((c) => c.card)
    expect(toNextPlay(game, answer(game, { indices: [0, 1, 2] }))).toBe(1)
    expect(game.state.players[0]?.hand).toHaveLength(2)
    for (const c of chosen) expect(game.state.discardPile).toContain(c)
  })

  it('手牌不超过体力时弃牌阶段不询问', () => {
    const game = setup({ players: players(2, { 0: { hp: 3, hand: [1] } }) })
    toNextPlay(game, game.start())
    answer(game, { action: 'end' })
    expect(expectRequest(game, 'play').player).toBe(1)
    expect(game.state.players[0]?.hand).toHaveLength(3)
  })

  it('skipPhases 中的阶段被跳过:触发 Phase.skipped,不触发 Phase.start / 正文 / Phase.end', () => {
    const game = setup({
      players: players(2, { 0: { skills: [...REC_SKILLS, 'skip-draw-play'], hand: [1] } }),
    })
    // 出牌阶段被跳过,第一个 play 请求属于 1 号
    expect(toNextPlay(game, game.start())).toBe(1)
    const rec = p0Records()
    expect(rec).toContain('p0 Phase.before:draw skipped')
    expect(rec).toContain('p0 Phase.skipped:draw skipped')
    expect(rec).toContain('p0 Phase.skipped:play skipped')
    expect(rec.some((r) => r.startsWith('p0 Phase.start:draw'))).toBe(false)
    expect(rec.some((r) => r.startsWith('p0 Phase.end:play'))).toBe(false)
    expect(rec.some((r) => r.startsWith('p0 DrawCards'))).toBe(false)
    expect(rec).toContain('p0 Phase.end:discard')
    expect(game.state.players[0]?.hand).toEqual([1])
    const skippedLogs = game.log
      .filter((e) => e.type === 'phaseSkipped')
      .map((e) => (e.data as { phase: string }).phase)
    expect(skippedLogs).toEqual(['draw', 'play'])
  })

  it('Phase.before 取消 = 跳过该阶段(触发 Phase.skipped)', () => {
    const game = setup({
      players: players(2, { 0: { skills: [...REC_SKILLS, 'cancel-before-draw'] } }),
    })
    expect(toNextPlay(game, game.start())).toBe(0)
    const rec = p0Records()
    expect(rec).toContain('p0 Phase.skipped:draw skipped')
    expect(rec.some((r) => r.startsWith('p0 Phase.start:draw'))).toBe(false)
    expect(rec.some((r) => r.startsWith('p0 DrawCards'))).toBe(false)
    expect(game.state.players[0]?.hand).toEqual([])
  })

  it('Phase.start 取消 = 不执行正文与 Phase.end,也不算跳过', () => {
    const game = setup({
      players: players(2, { 0: { skills: [...REC_SKILLS, 'cancel-start-draw'] } }),
    })
    expect(toNextPlay(game, game.start())).toBe(0)
    const rec = p0Records()
    // 钩子(优先级 1)先于记录器取消事件,本时机随即终止;阶段本身已进入(写了 phase 日志)
    expect(
      game.log.some((e) => e.type === 'phase' && (e.data as { phase: string }).phase === 'draw'),
    ).toBe(true)
    expect(rec.some((r) => r.startsWith('p0 DrawCards'))).toBe(false)
    expect(rec.some((r) => r.startsWith('p0 Phase.end:draw'))).toBe(false)
    expect(rec.some((r) => r.startsWith('p0 Phase.skipped:draw'))).toBe(false)
    expect(rec).toContain('p0 Phase.before:play')
    expect(game.state.players[0]?.hand).toEqual([])
  })

  it('@phase 标记在阶段结束清除、@turn 标记在回合结束清除,持久标记保留', () => {
    const game = setup({ players: players(2, { 0: { skills: ['set-marks', 'probe-judge'] } }) })
    toNextPlay(game, game.start())
    expect(records).toEqual(['judge 时标记:f,f@turn,m,m@turn'])
    const p0 = (): NonNullable<(typeof game.state.players)[number]> => {
      const p = game.state.players[0]
      if (p === undefined) throw new EngineError('玩家 0 不存在')
      return p
    }
    expect(p0().marks).toEqual({ 'm@turn': 2, m: 3 })
    expect(game.state.turn?.counters).toEqual({ 'c@turn': 1 })
    expect(game.state.flags).toEqual({ 'g@turn': 1, g: 1 })
    expect(endPlay(game)).toBe(1)
    expect(p0().flags).toEqual({ f: true })
    expect(p0().marks).toEqual({ m: 3 })
    expect(game.state.flags).toEqual({ g: 1 })
    // 视图里公开的 marks 同样已清理
    expect(game.viewFor(1).players[0]?.marks).toEqual({ m: 3 })
  })

  it('回合玩家死亡后剩余阶段不执行,Turn.end 照常,下一名存活者开始回合', () => {
    const game = setup({
      players: players(3, {
        0: { hp: 1, skills: ['lose-hp-after-draw'] },
        1: { skills: REC_SKILLS },
      }),
    })
    // 濒死求桃的 askCard 请求由 toNextPlay 给默认应答(不出桃)
    expect(toNextPlay(game, game.start())).toBe(1)
    expect(game.state.players[0]?.alive).toBe(false)
    const rec = p0Records()
    expect(rec).toContain('p0 Phase.end:draw')
    for (const phase of ['play', 'discard', 'finish'] as const) {
      expect(rec.some((r) => r.includes(`:${phase}`))).toBe(false)
    }
    expect(rec[rec.length - 1]).toBe('p0 Turn.end')
    expect(game.state.lastTurnPlayer).toBe(0)
  })

  it('下一回合玩家为座位序下一名存活者(跳过死者、绕回 0 号之后)', () => {
    const game = setup({
      players: players(4, { 0: { alive: false }, 2: { alive: false } }),
      lastTurnPlayer: 3,
    })
    expect(toNextPlay(game, game.start())).toBe(1)
    expect(endPlay(game)).toBe(3)
    expect(endPlay(game)).toBe(1)
  })

  it('turnQueue 优先于座位序,出队后恢复座位序', () => {
    const game = setup({ players: players(3) })
    game.state.turnQueue.push(2, 2)
    expect(toNextPlay(game, game.start())).toBe(2)
    expect(game.state.turnQueue).toEqual([2])
    expect(endPlay(game)).toBe(2)
    expect(game.state.turnQueue).toEqual([])
    expect(endPlay(game)).toBe(0)
  })

  it('turnCount 达到 maxTurns 时以 winners = [] 平局结束', () => {
    const game = setup({ players: players(2) }, { maxTurns: 2 })
    expect(toNextPlay(game, game.start())).toBe(0)
    expect(endPlay(game)).toBe(1)
    const r = answer(game, { action: 'end' })
    expect(r.type).toBe('over')
    if (r.type === 'over') expect(r.result).toEqual({ winners: [], reason: 'maxTurns' })
    expect(game.state.turnCount).toBe(2)
    expect(game.state.phase).toBe('over')
    expect(game.state.result).toEqual({ winners: [], reason: 'maxTurns' })
  })

  it('起始 turnCount 已达 maxTurns 时 start 直接平局结束', () => {
    const game = setup({ players: players(2), turnCount: 5 }, { maxTurns: 5 })
    const r = game.start()
    expect(r.type).toBe('over')
    if (r.type === 'over') expect(r.result.winners).toEqual([])
  })
})
