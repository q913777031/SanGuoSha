/**
 * core/view.ts ─ 信息隐藏(§8):玩家视角的视图、结算栈摘要与日志可见性过滤。
 * viewFor 是只读纯函数;守则:任何隐藏牌一律不以 id 出现在他人的 view / Request / log 中。
 */
import { EngineError } from './engine.js'
import { faceOf } from './state.js'
import { skillsOf } from './trigger.js'
import type {
  Ctx,
  EventSummary,
  GameEvent,
  LogEntry,
  PlayerId,
  PlayerView,
  PublicPlayerView,
  Request,
} from './types.js'
import { cloneJson } from './hash.js'

/** 结算栈中单个事件的遮蔽摘要;CardsMove / DrawCards 不进摘要(返回 null) */
export function eventSummary(ctx: Ctx, ev: GameEvent): EventSummary | null {
  switch (ev.kind) {
    case 'CardsMove':
    case 'DrawCards':
      return null
    case 'GameStart':
      return { id: ev.id, kind: ev.kind, card: null, source: null, targets: [] }
    case 'Turn':
    case 'Phase':
    case 'LoseHp':
    case 'Dying':
    case 'Death':
      return { id: ev.id, kind: ev.kind, card: null, source: null, targets: [ev.player] }
    case 'AskCard':
      return { id: ev.id, kind: ev.kind, card: null, source: ev.player, targets: [...ev.targets] }
    case 'CardUse':
      return {
        id: ev.id,
        kind: ev.kind,
        card: { ...ev.card, subcards: [...ev.card.subcards] },
        source: ev.source,
        targets: [...ev.targets],
      }
    case 'CardRespond':
      return {
        id: ev.id,
        kind: ev.kind,
        card: { ...ev.card, subcards: [...ev.card.subcards] },
        source: ev.player,
        targets: [],
      }
    case 'CardEffect':
      return {
        id: ev.id,
        kind: ev.kind,
        card: { ...ev.card, subcards: [...ev.card.subcards] },
        source: ev.source,
        targets: ev.target === null ? [] : [ev.target],
      }
    case 'Damage':
      return {
        id: ev.id,
        kind: ev.kind,
        card: ev.card === null ? null : { ...ev.card, subcards: [...ev.card.subcards] },
        source: ev.from,
        targets: [ev.to],
      }
    case 'Recover':
      return {
        id: ev.id,
        kind: ev.kind,
        card: ev.card === null ? null : { ...ev.card, subcards: [...ev.card.subcards] },
        source: ev.source,
        targets: [ev.to],
      }
    case 'Judge':
      return {
        id: ev.id,
        kind: ev.kind,
        card: ev.card === null ? null : faceOf(ctx, ev.card),
        source: null,
        targets: [ev.player],
      }
  }
}

/** 某玩家视角的视图:只含自己的手牌;他人身份按 mode.roleVisible 遮蔽 */
export function viewFor(ctx: Ctx, viewer: PlayerId, pending: Request | null): PlayerView {
  const s = ctx.state
  const me = s.players[viewer]
  if (me === undefined) throw new EngineError(`玩家 ${viewer} 不存在`)
  const mode = ctx.registry.mode(s.mode)
  const players: PublicPlayerView[] = s.players.map((p) => ({
    id: p.id,
    general: p.general,
    kingdom: p.kingdom,
    gender: p.gender,
    hp: p.hp,
    maxHp: p.maxHp,
    alive: p.alive,
    handCount: p.hand.length,
    equips: { ...p.equips },
    judgeArea: [...p.judgeArea],
    judgeAs: { ...p.judgeAs },
    role: p.id === viewer || mode.roleVisible(ctx, viewer, p.id) ? p.role : 'hidden',
    roleRevealed: p.roleRevealed,
    skills: skillsOf(ctx, p.id).map((skill) => skill.id),
    marks: { ...p.marks },
  }))
  const stack: EventSummary[] = []
  for (const ev of s.stack) {
    const summary = eventSummary(ctx, ev)
    if (summary !== null) stack.push(summary)
  }
  return {
    me: viewer,
    role: me.role,
    hand: [...me.hand],
    players,
    drawPileCount: s.drawPile.length,
    discardPile: [...s.discardPile],
    processing: [...s.processing],
    turn: s.turn === null ? null : cloneJson(s.turn),
    turnCount: s.turnCount,
    stack,
    waitingFor: pending === null ? null : pending.player,
    result: s.result === null ? null : cloneJson(s.result),
  }
}

/** 过滤出某玩家可见的日志(visibleTo 为 null 即公开) */
export function visibleTo(logs: readonly LogEntry[], player: PlayerId): LogEntry[] {
  return logs.filter((entry) => entry.visibleTo === null || entry.visibleTo.includes(player))
}
