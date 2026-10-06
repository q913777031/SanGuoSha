/**
 * core/state.ts ─ 初始状态与派生查询(玩家 / 座位序 / 距离 / 使用限制 / 候选集)。
 * 所有查询只读 GameState + Registry,候选集与 validateResponse 共用这里的函数(不存在"两处真相")。
 */
import { matchPattern } from '../cards/pattern.js'
import { EngineError } from './engine.js'
import { fold } from './modifiers.js'
import { skillsOf } from './trigger.js'
import type {
  CardDef,
  CardFace,
  CardId,
  CardName,
  CardPattern,
  CardSelection,
  CardUseMode,
  ChooseCardCandidate,
  Ctx,
  EventId,
  GameConfig,
  GameEvent,
  GameState,
  JsonValue,
  PlayerId,
  PlayerState,
  Registry,
  SkillId,
  TargetSpec,
  UsableCard,
  UsableSkill,
  ViewAsSkill,
  Zone,
} from './types.js'
import { EQUIP_SLOTS, STATE_SCHEMA_VERSION, UNLIMITED } from './types.js'
import { seedRng } from './rng.js'

/** 开局前的纯数据状态:全部牌按 id 升序在牌堆,玩家只有座位号(武将 / 体力由 mode.setup 填) */
export function createInitialState(config: GameConfig, registry: Registry): GameState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    seed: config.seed,
    rng: seedRng(config.seed),
    mode: config.mode,
    phase: 'setup',
    players: config.players.map((p, id) => ({
      id,
      general: p.general ?? '',
      kingdom: 'qun',
      gender: 'male',
      role: 'none',
      roleRevealed: false,
      hp: 0,
      maxHp: 0,
      alive: true,
      hand: [],
      equips: { weapon: null, armor: null, horse_offensive: null, horse_defensive: null },
      judgeArea: [],
      judgeAs: {},
      skills: [],
      flags: {},
      marks: {},
    })),
    drawPile: registry.deck.map((c) => c.id),
    discardPile: [],
    processing: [],
    turn: null,
    turnCount: 0,
    lastTurnPlayer: null,
    turnQueue: [],
    stack: [],
    nextEventId: 1,
    nextRequestId: 1,
    flags: {},
    result: null,
  }
}

/** 按座位号取玩家;不存在即引擎错误 */
export function playerOf(ctx: Ctx, id: PlayerId): PlayerState {
  const p = ctx.state.players[id]
  if (p === undefined) throw new EngineError(`玩家 ${id} 不存在`)
  return p
}

/** 从 start 起顺时针的全部玩家(含死者),长度恒为玩家数 */
export function playersFrom(state: GameState, start: PlayerId): PlayerState[] {
  const n = state.players.length
  const result: PlayerState[] = []
  for (let i = 0; i < n; i++) {
    const p = state.players[(start + i) % n]
    if (p !== undefined) result.push(p)
  }
  return result
}

/** after 之后(不含)的下一名存活玩家;after 为 null 时从 0 号位(含)起找;无存活者返回 null */
export function nextAlive(state: GameState, after: PlayerId | null): PlayerId | null {
  const n = state.players.length
  const start = after === null ? 0 : after + 1
  for (let i = 0; i < n; i++) {
    const p = state.players[(start + i) % n]
    if (p !== undefined && p.alive) return p.id
  }
  return null
}

/** 触发 / 询问的起点座位:当前回合玩家(已死亡也以其座位为起点);无回合时为 0 */
export function anchor(state: GameState): PlayerId {
  return state.turn === null ? 0 : state.turn.player
}

/** 目标按"从使用者起顺时针"排序(使用者是目标时第一);去重、稳定 */
export function orderTargets(state: GameState, source: PlayerId, targets: PlayerId[]): PlayerId[] {
  const n = state.players.length
  const seen: boolean[] = []
  const unique = targets.filter((t) => {
    if (seen[t]) return false
    seen[t] = true
    return true
  })
  return unique.sort((a, b) => ((a - source + n) % n) - ((b - source + n) % n))
}

/** 在结算栈上按 id 查找正在结算的事件;不在栈上(已出栈)返回 null */
export function eventById(state: GameState, id: EventId): GameEvent | null {
  for (const ev of state.stack) if (ev.id === id) return ev
  return null
}

/** 存活环上的座位距离(两个方向取小);同一人为 0;任一方不在存活环上则按全体座位计算 */
export function seatDistance(state: GameState, a: PlayerId, b: PlayerId): number {
  if (a === b) return 0
  const ring = state.players.filter((p) => p.alive).map((p) => p.id)
  const ia = ring.indexOf(a)
  const ib = ring.indexOf(b)
  if (ia < 0 || ib < 0) {
    const n = state.players.length
    const d = Math.abs(a - b)
    return Math.min(d, n - d)
  }
  const d = Math.abs(ia - ib)
  return Math.min(d, ring.length - d)
}

function equipDef(ctx: Ctx, card: CardId | null): CardDef | null {
  if (card === null) return null
  return ctx.registry.card(ctx.registry.spec(card).name)
}

/** 武器射程基值:有武器取其 equip.range(未注册的武器视为 1),无武器为 1 */
export function weaponRange(ctx: Ctx, player: PlayerId): number {
  const def = equipDef(ctx, playerOf(ctx, player).equips.weapon)
  return def?.equip?.range ?? 1
}

/** 攻击范围 = 武器基值经 attackRange 钩子折叠 */
export function attackRange(ctx: Ctx, player: PlayerId): number {
  return fold(ctx, 'attackRange', weaponRange(ctx, player), player)
}

/** 距离 = max(1, 座位距离 + 进攻马修正(经 distanceFrom)+ 防御马修正(经 distanceTo)) */
export function distance(ctx: Ctx, from: PlayerId, to: PlayerId): number {
  const offensive = equipDef(ctx, playerOf(ctx, from).equips.horse_offensive)?.equip?.distance ?? 0
  const defensive = equipDef(ctx, playerOf(ctx, to).equips.horse_defensive)?.equip?.distance ?? 0
  const base = seatDistance(ctx.state, from, to)
  const d =
    base +
    fold(ctx, 'distanceFrom', offensive, from, to) +
    fold(ctx, 'distanceTo', defensive, from, to)
  return Math.max(1, d)
}

/** to 是否在 from 的攻击范围内 */
export function inAttackRange(ctx: Ctx, from: PlayerId, to: PlayerId): boolean {
  return distance(ctx, from, to) <= attackRange(ctx, from)
}

/** 出牌阶段使用某牌的次数上限:杀 1、其余 UNLIMITED,经 useLimit 钩子折叠 */
export function useLimit(ctx: Ctx, player: PlayerId, card: CardFace): number {
  return fold(ctx, 'useLimit', card.name === 'slash' ? 1 : UNLIMITED, player, card)
}

/** 本回合该玩家在出牌阶段主动使用(reason === 'play')某牌的次数;借刀 / 激将令其使用的不计 */
export function usedInPlay(ctx: Ctx, player: PlayerId, name: CardName): number {
  const turn = ctx.state.turn
  if (turn === null) return 0
  let n = 0
  for (const h of turn.history) {
    if (h.player === player && h.card === name && h.reason === 'play' && h.mode === 'use') n++
  }
  return n
}

/** 手牌上限 = hp(不低于 0)经 maxHandCards 钩子折叠 */
export function maxHandCards(ctx: Ctx, player: PlayerId): number {
  return fold(ctx, 'maxHandCards', Math.max(0, playerOf(ctx, player).hp), player)
}

/** 实体牌的 CardFace(M1 恒为单张) */
export function faceOf(ctx: Ctx, card: CardId): CardFace {
  const spec = ctx.registry.spec(card)
  return { name: spec.name, suit: spec.suit, number: spec.number, subcards: [card], viewAs: null }
}

/** 判定区中一张牌的牌面:转化而来的(国色当乐)按 judgeAs 记录的牌名,其余同 faceOf;转化来源技能不记录 */
export function judgeFaceOf(ctx: Ctx, player: PlayerId, card: CardId): CardFace {
  const face = faceOf(ctx, card)
  const as = playerOf(ctx, player).judgeAs[String(card)]
  return as === undefined ? face : { ...face, name: as }
}

/** CardFace 的纯数据快照(写日志用) */
export function faceToJson(face: CardFace): JsonValue {
  return {
    name: face.name,
    suit: face.suit,
    number: face.number,
    subcards: [...face.subcards],
    viewAs: face.viewAs,
  }
}

/** Zone 的纯数据快照(写日志用) */
export function zoneToJson(zone: Zone): JsonValue {
  return zone.kind === 'hand' || zone.kind === 'equip' || zone.kind === 'judge'
    ? { kind: zone.kind, player: zone.player }
    : { kind: zone.kind }
}

/** 手牌数 */
export function handCount(ctx: Ctx, player: PlayerId): number {
  return playerOf(ctx, player).hand.length
}

/** 本人手牌作为 chooseCards 候选(带 id) */
export function handCandidates(ctx: Ctx, player: PlayerId): ChooseCardCandidate[] {
  return playerOf(ctx, player).hand.map((card, index) => ({
    index,
    card,
    zone: { kind: 'hand', player },
  }))
}

/** 一张牌使用时能否被无懈可击响应:按 CardDef.nullifiable(未注册的牌为 false) */
export function defaultNullifiable(ctx: Ctx, face: CardFace): boolean {
  return ctx.registry.card(face.name)?.nullifiable ?? false
}

/** 清除 state.flags / 各玩家 flags、marks / turn.counters 中以 suffix 结尾的 key(@turn / @phase 生命周期) */
export function clearScopedFlags(state: GameState, suffix: '@turn' | '@phase'): void {
  const clear = (record: Record<string, unknown>): void => {
    for (const key of Object.keys(record)) if (key.endsWith(suffix)) delete record[key]
  }
  clear(state.flags)
  for (const p of state.players) {
    clear(p.flags)
    clear(p.marks)
  }
  if (state.turn !== null) clear(state.turn.counters)
}

function withinRange(
  ctx: Ctx,
  user: PlayerId,
  target: PlayerId,
  def: CardDef,
  face: CardFace,
): boolean {
  const range = def.target.range
  if (range === null) return true
  if (fold(ctx, 'ignoreDistance', false, user, face)) return true
  if (range === 'attack') return inAttackRange(ctx, user, target)
  return distance(ctx, user, target) <= range
}

/** 玩家可选的目标约束:存活 − 自己(excludeSelf)− 距离不满足 − prohibitTarget − !filter;max 加 extraTargets */
export function legalTargets(ctx: Ctx, user: PlayerId, face: CardFace, def: CardDef): TargetSpec {
  const candidates: PlayerId[] = []
  for (const p of ctx.state.players) {
    if (!p.alive) continue
    if (def.target.excludeSelf && p.id === user) continue
    if (!withinRange(ctx, user, p.id, def, face)) continue
    if (fold(ctx, 'prohibitTarget', false, user, p.id, face)) continue
    if (def.target.filter && !def.target.filter(ctx, user, p.id, [], face)) continue
    candidates.push(p.id)
  }
  const extra = fold(ctx, 'extraTargets', 0, user, face)
  const max = def.target.max === 'all' ? candidates.length : def.target.max + extra
  return { candidates, min: def.target.min, max: Math.min(max, candidates.length) }
}

/** 引擎自动填充的目标(target.auto):self / allOthers / all;同样受 prohibitTarget 与 filter 约束 */
export function autoTargets(ctx: Ctx, user: PlayerId, face: CardFace, def: CardDef): PlayerId[] {
  const auto = def.target.auto
  if (auto === null) return []
  if (auto === 'self') return [user]
  const result: PlayerId[] = []
  for (const p of playersFrom(ctx.state, user)) {
    if (!p.alive) continue
    if (auto === 'allOthers' && p.id === user) continue
    if (fold(ctx, 'prohibitTarget', false, user, p.id, face)) continue
    if (def.target.filter && !def.target.filter(ctx, user, p.id, [], face)) continue
    result.push(p.id)
  }
  return result
}

/** 使用一张牌的最终目标:显式目标优先;否则 auto 规则;否则(零目标牌)为空 */
export function resolveUseTargets(
  ctx: Ctx,
  user: PlayerId,
  face: CardFace,
  explicit: PlayerId[],
): PlayerId[] {
  if (explicit.length > 0) return [...explicit]
  const def = ctx.registry.card(face.name)
  if (def === null) throw new EngineError(`牌 ${face.name} 未注册,不能使用`)
  return autoTargets(ctx, user, face, def)
}

/** 出牌阶段可使用的手牌及其目标约束:未注册 / canUse 为假 / 目标不足的牌一律排除 */
export function usableCards(ctx: Ctx, player: PlayerId): UsableCard[] {
  const result: UsableCard[] = []
  for (const card of playerOf(ctx, player).hand) {
    const face = faceOf(ctx, card)
    const def = ctx.registry.card(face.name)
    if (def === null) continue
    if (def.canUse && !def.canUse(ctx, player, face)) continue
    if (def.target.auto !== null) {
      const targets = autoTargets(ctx, player, face, def)
      if (targets.length === 0 && def.target.auto !== 'self') continue
      result.push({ card, targets: { candidates: [], min: 0, max: 0 } })
      continue
    }
    const targets = legalTargets(ctx, player, face, def)
    if (targets.candidates.length < targets.min) continue
    result.push({ card, targets })
  }
  return result
}

/** 技能选牌约束:zones(缺省 ['hand'])内被 accept 的牌,手牌序,再按槽序的装备;候选与校验共用 */
function cardSelectionFor(
  ctx: Ctx,
  player: PlayerId,
  zones: ReadonlyArray<'hand' | 'equip'> | undefined,
  min: number,
  max: number,
  accept: (card: CardId) => boolean,
): CardSelection {
  const p = playerOf(ctx, player)
  const from = zones ?? ['hand']
  const pool = from.includes('hand') ? [...p.hand] : []
  if (from.includes('equip')) {
    for (const slot of EQUIP_SLOTS) {
      const card = p.equips[slot]
      if (card !== null) pool.push(card)
    }
  }
  return { candidates: pool.filter(accept), min, max }
}

/** 出牌阶段可发动的主动技 / 转化技及其选牌、选目标约束(M3;M1 恒为空) */
export function usableSkills(ctx: Ctx, player: PlayerId): UsableSkill[] {
  const result: UsableSkill[] = []
  for (const skill of skillsOf(ctx, player)) {
    if (skill.type === 'active') {
      if (!skill.canUse(ctx, player)) continue
      const cards = cardSelectionFor(
        ctx,
        player,
        skill.cards.zones,
        skill.cards.min,
        skill.cards.max,
        (card) => skill.cards.filter(ctx, player, card, []),
      )
      if (cards.candidates.length < cards.min) continue
      const candidates = ctx.state.players
        .filter((p) => p.alive && skill.targets.filter(ctx, player, p.id, []))
        .map((p) => p.id)
      if (candidates.length < skill.targets.min) continue
      result.push({
        skill: skill.id,
        kind: 'active',
        as: null,
        cards,
        targets: { candidates, min: skill.targets.min, max: skill.targets.max },
      })
    } else if (skill.type === 'viewAs') {
      for (const as of skill.produces) {
        const def = ctx.registry.card(as)
        if (def === null || !skill.enabledAtPlay(ctx, player, as)) continue
        const face: CardFace = { name: as, suit: 'none', number: 0, subcards: [], viewAs: skill.id }
        // 与 usableCards 一致:出杀次数(useLimit)等使用条件同样约束转化牌
        if (def.canUse && !def.canUse(ctx, player, face)) continue
        const cards = cardSelectionFor(
          ctx,
          player,
          skill.zones,
          skill.cardCount[0],
          skill.cardCount[1],
          (card) => skill.cardFilter(ctx, player, card, [], as),
        )
        if (cards.candidates.length < cards.min) continue
        const targets =
          def.target.auto !== null
            ? { candidates: [], min: 0, max: 0 }
            : legalTargets(ctx, player, face, def)
        if (targets.candidates.length < targets.min) continue
        result.push({ skill: skill.id, kind: 'viewAs', as, cards, targets })
      }
    }
  }
  return result
}

/** 本人符合 pattern 且已注册(可使用 / 打出)的实体牌:手牌序,再按槽序的装备(pattern.zones 含 'equip' 时) */
export function matchingCards(ctx: Ctx, player: PlayerId, pattern: CardPattern): CardId[] {
  const p = playerOf(ctx, player)
  const zones = pattern.zones ?? ['hand']
  const result: CardId[] = []
  const accept = (card: CardId): boolean => {
    const spec = ctx.registry.spec(card)
    return ctx.registry.card(spec.name) !== null && matchPattern(spec, pattern)
  }
  if (zones.includes('hand')) for (const card of p.hand) if (accept(card)) result.push(card)
  if (zones.includes('equip')) {
    for (const slot of EQUIP_SLOTS) {
      const card = p.equips[slot]
      if (card !== null && accept(card)) result.push(card)
    }
  }
  return result
}

/** 可转化出符合 pattern 的牌的技能及其选牌约束(M3;M1 恒为空) */
export function viewAsOptions(
  ctx: Ctx,
  player: PlayerId,
  pattern: CardPattern,
  mode: CardUseMode,
): Array<{ skill: SkillId; cards: CardSelection }> {
  const result: Array<{ skill: SkillId; cards: CardSelection }> = []
  for (const skill of skillsOf(ctx, player)) {
    if (skill.type !== 'viewAs') continue
    const as = viewAsTarget(ctx, skill, pattern)
    if (as === null || !skill.enabledAtResponse(ctx, player, pattern, mode)) continue
    const cards = cardSelectionFor(
      ctx,
      player,
      skill.zones,
      skill.cardCount[0],
      skill.cardCount[1],
      (card) => skill.cardFilter(ctx, player, card, [], as),
    )
    if (cards.candidates.length < cards.min) continue
    result.push({ skill: skill.id, cards })
  }
  return result
}

function viewAsTarget(ctx: Ctx, skill: ViewAsSkill, pattern: CardPattern): CardName | null {
  for (const name of skill.produces) {
    if (ctx.registry.card(name) === null) continue
    if (pattern.names === null || pattern.names.includes(name)) return name
  }
  return null
}

/** 以转化技响应询问时产出的虚拟牌;技能拒绝(返回 null)即视为未响应 */
export function viewAsFace(
  ctx: Ctx,
  player: PlayerId,
  viewAs: { skill: SkillId; cards: CardId[] },
  pattern: CardPattern,
): CardFace | null {
  const skill = ctx.registry.skill(viewAs.skill)
  if (skill.type !== 'viewAs') return null
  const as = viewAsTarget(ctx, skill, pattern)
  if (as === null) return null
  return skill.viewAs(ctx, player, viewAs.cards, as)
}
