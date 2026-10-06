/**
 * events/game.ts ─ 顶层循环与 GameStart / Turn / Phase 事件(含六阶段正文)。
 * 回合边界(进入 Turn 前)是唯一的快照点:此时结算栈为空。
 */
import { EngineError, GameOver, gameOver, runEvent, stage } from '../core/engine.js'
import { ask } from '../core/flow.js'
import {
  clearScopedFlags,
  defaultNullifiable,
  faceOf,
  handCandidates,
  maxHandCards,
  nextAlive,
  playerOf,
  resolveUseTargets,
  usableCards,
  usableSkills,
} from '../core/state.js'
import type {
  CardId,
  Ctx,
  Flow,
  GameStartEvent,
  Phase,
  PhaseEvent,
  TurnEvent,
} from '../core/types.js'
import { PHASES } from '../core/types.js'
import { moveCards, zoneOf } from '../core/zones.js'

/** 顶层循环:GameStart(仅 setup 阶段)→ 反复取下一名回合玩家运行 Turn;GameOver 在此被吞掉 */
export function* runGame(ctx: Ctx): Flow<void> {
  const s = ctx.state
  try {
    if (s.phase === 'setup') {
      yield* runEvent(ctx, { kind: 'GameStart' })
      s.phase = 'running'
    }
    for (;;) {
      if (s.turnCount >= ctx.options.maxTurns) gameOver(ctx, { winners: [], reason: 'maxTurns' })
      // 先取快照再出队:恢复时从 base 重算 next 才能得到同一名玩家(额外回合队列不会被消费两次)
      ctx.onTurnBoundary()
      const queued = s.turnQueue.shift()
      const next = queued ?? nextAlive(s, s.lastTurnPlayer)
      if (next === null) gameOver(ctx, { winners: [], reason: 'noAlivePlayers' })
      yield* runEvent(ctx, { kind: 'Turn', player: next })
    }
  } catch (e) {
    if (e instanceof GameOver) return
    throw e
  }
}

/** GameStart:mode.setup(分武将 / 身份、体力、洗牌、发初始手牌)→ Game.start 时机 */
export function* onGameStart(ctx: Ctx, ev: GameStartEvent): Flow<void> {
  const mode = ctx.registry.mode(ctx.state.mode)
  yield* mode.setup(ctx)
  ctx.log({
    type: 'gameStart',
    data: {
      mode: mode.id,
      players: ctx.state.players.map((p) => ({ id: p.id, general: p.general, maxHp: p.maxHp })),
    },
    visibleTo: null,
    eventId: ev.id,
  })
  yield* stage(ctx, 'Game.start', ev)
}

/** Turn:置 state.turn → Turn.start → 六个 Phase(回合玩家死亡即中止)→ Turn.end;finally 清理 @turn 标记 */
export function* onTurn(ctx: Ctx, ev: TurnEvent): Flow<void> {
  const s = ctx.state
  s.turn = { player: ev.player, phase: null, skipPhases: [], history: [], counters: {} }
  s.turnCount++
  ctx.log({
    type: 'turnStart',
    data: { player: ev.player, turnCount: s.turnCount },
    visibleTo: null,
    eventId: ev.id,
  })
  try {
    if (!(yield* stage(ctx, 'Turn.start', ev))) return
    for (const phase of PHASES) {
      if (!playerOf(ctx, ev.player).alive) break
      yield* runEvent(ctx, { kind: 'Phase', player: ev.player, phase, skipped: false })
    }
    yield* stage(ctx, 'Turn.end', ev)
  } finally {
    clearScopedFlags(s, '@turn')
    s.lastTurnPlayer = ev.player
    s.turn = null
  }
}

/** Phase:skipPhases / Phase.before 取消 ⇒ Phase.skipped;否则 Phase.start → 正文 → Phase.end;finally 清理 @phase 标记 */
export function* onPhase(ctx: Ctx, ev: PhaseEvent): Flow<void> {
  const t = ctx.state.turn
  if (t === null) throw new EngineError('Phase 事件必须在 Turn 内运行')
  if (t.skipPhases.includes(ev.phase)) ev.skipped = true
  const ok = yield* stage(ctx, 'Phase.before', ev)
  if (!ok || ev.skipped) {
    ev.skipped = true
    ctx.log({
      type: 'phaseSkipped',
      data: { player: ev.player, phase: ev.phase },
      visibleTo: null,
      eventId: ev.id,
    })
    yield* stage(ctx, 'Phase.skipped', ev)
    return
  }
  t.phase = ev.phase
  ctx.log({
    type: 'phase',
    data: { player: ev.player, phase: ev.phase },
    visibleTo: null,
    eventId: ev.id,
  })
  try {
    if (!(yield* stage(ctx, 'Phase.start', ev))) return
    yield* PHASE_BODY[ev.phase](ctx, ev)
    yield* stage(ctx, 'Phase.end', ev)
  } finally {
    clearScopedFlags(ctx.state, '@phase')
    t.phase = null
  }
}

function* emptyPhase(): Flow<void> {}

/** 判定阶段:对判定区快照倒序(后放置先判定)逐张以 delayed CardEffect 生效;本阶段新进入的牌不判 */
function* judgePhase(ctx: Ctx, ev: PhaseEvent): Flow<void> {
  const p = ev.player
  const cards = [...playerOf(ctx, p).judgeArea].reverse()
  for (const card of cards) {
    if (!playerOf(ctx, p).alive) break
    const z = zoneOf(ctx.state, card)
    if (z.kind !== 'judge' || z.player !== p) continue
    const def = ctx.registry.card(ctx.registry.spec(card).name)
    if (def === null) throw new EngineError(`判定区的牌 ${card} 未注册`)
    yield* moveCards(ctx, [{ card, to: { kind: 'processing' }, reason: 'delayed_trick' }])
    yield* runEvent(ctx, {
      kind: 'CardEffect',
      useId: null,
      card: faceOf(ctx, card),
      source: null,
      target: p,
      delayed: true,
      nullifiable: def.nullifiable,
      nullified: false,
      voided: false,
      responded: false,
      requiredResponses: 0,
    })
    if (zoneOf(ctx.state, card).kind === 'processing') {
      yield* moveCards(ctx, [{ card, to: { kind: 'discard' }, reason: 'delayed_trick' }])
    }
  }
}

/** 摸牌阶段:DrawCards 2 张(英姿 / 突袭等在 DrawCards.before 改量或取消) */
function* drawPhase(ctx: Ctx, ev: PhaseEvent): Flow<void> {
  yield* runEvent(ctx, {
    kind: 'DrawCards',
    player: ev.player,
    count: 2,
    reason: 'phase',
    cards: [],
  })
}

/** 出牌阶段:反复发 play 请求,使用牌 / 发动技能,直到结束或回合玩家死亡 */
function* playPhase(ctx: Ctx, ev: PhaseEvent): Flow<void> {
  const p = ev.player
  for (;;) {
    if (!playerOf(ctx, p).alive) break
    const r = yield* ask(ctx, {
      kind: 'play',
      player: p,
      usableCards: usableCards(ctx, p),
      usableSkills: usableSkills(ctx, p),
      reason: null,
      prompt: { key: 'play', args: {} },
    })
    if (r.action === 'end') break
    if (r.action === 'useCard') {
      const face = faceOf(ctx, r.card)
      yield* runEvent(ctx, {
        kind: 'CardUse',
        source: p,
        card: face,
        targets: resolveUseTargets(ctx, p, face, r.targets),
        currentTarget: null,
        reason: 'play',
        againstId: null,
        nullifiable: defaultNullifiable(ctx, face),
        responseCounts: {},
      })
      continue
    }
    const skill = ctx.registry.skill(r.skill)
    if (skill.type === 'active') {
      ctx.log({
        type: 'skillInvoked',
        data: { player: p, skill: skill.id, eventId: ev.id, timing: 'play' },
        visibleTo: null,
        eventId: ev.id,
      })
      yield* skill.effect(ctx, p, r.cards, r.targets)
    } else if (skill.type === 'viewAs') {
      if (r.as === null) throw new EngineError(`转化技 ${skill.id} 的应答缺少 as`)
      const face = skill.viewAs(ctx, p, r.cards, r.as)
      if (face === null) throw new EngineError(`转化技 ${skill.id} 拒绝了已通过校验的选牌`)
      yield* runEvent(ctx, {
        kind: 'CardUse',
        source: p,
        card: face,
        targets: resolveUseTargets(ctx, p, face, r.targets),
        currentTarget: null,
        reason: 'play',
        againstId: null,
        nullifiable: defaultNullifiable(ctx, face),
        responseCounts: {},
      })
    } else {
      throw new EngineError(`技能 ${skill.id} 不能在出牌阶段主动发动`)
    }
  }
}

/** 弃牌阶段:手牌超过上限则 chooseCards 弃至上限 */
function* discardPhase(ctx: Ctx, ev: PhaseEvent): Flow<void> {
  const p = ev.player
  const player = playerOf(ctx, p)
  const excess = player.hand.length - maxHandCards(ctx, p)
  if (excess <= 0) return
  const candidates = handCandidates(ctx, p)
  const r = yield* ask(ctx, {
    kind: 'chooseCards',
    player: p,
    candidates,
    min: excess,
    max: excess,
    cancellable: false,
    reason: ev.id,
    prompt: { key: 'discard', args: { count: excess } },
  })
  const cards: CardId[] = []
  for (const index of r.indices) {
    const c = candidates[index]
    if (c === undefined || c.card === null) throw new EngineError(`弃牌候选 ${index} 不存在`)
    cards.push(c.card)
  }
  ctx.log({
    type: 'discard',
    data: { player: p, cards: [...cards] },
    visibleTo: null,
    eventId: ev.id,
  })
  yield* moveCards(
    ctx,
    cards.map((card) => ({ card, to: { kind: 'discard' as const }, reason: 'discard' as const })),
  )
}

const PHASE_BODY: Record<Phase, (ctx: Ctx, ev: PhaseEvent) => Flow<void>> = {
  prepare: emptyPhase,
  judge: judgePhase,
  draw: drawPhase,
  play: playPhase,
  discard: discardPhase,
  finish: emptyPhase,
}
