/**
 * packages/engine/src/core/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * 规则引擎核心类型(来自 docs/engine-core-types.draft.ts,按实现需要微调)。
 * 本文件只含类型、接口与少量常量,不依赖任何实现模块。
 *
 * 约定(违反即视为 bug,由单测/lint 锁住):
 *  1. GameState 及其全部子结构是纯数据:JSON.stringify → parse 往返后语义不变。
 *     禁止函数、类实例、Map/Set、Date、undefined、Infinity/NaN;"无"一律写 null。
 *  2. 事件之间只用 EventId 互相引用(useId / againstId / causeId …),绝不持有对象引用。
 *     正在结算的事件都在 state.stack 上,eventById(state, id) 只在栈上查找。
 *  3. 引擎与外界的唯一交互是 Request / Response,两者都是纯数据、可跨进程。
 *  4. 一切"可能需要玩家决策"的函数都是 Flow<T>(生成器),调用方必须 yield*。
 *  5. 代码(卡牌 / 技能 / 武将 / 模式定义)只存在于 Registry;状态里只保存 id。
 *  6. 对局日志(LogEntry)不是状态:不进 GameState、不进 stateHash,由 Game 另行保存。
 *
 * 相对草案的微调:
 *  - CardSpec 增加 type(由 DeckEntry.kind 派生),使 matchPattern 不依赖 CardDef;
 *  - Ctx 增加 onTurnBoundary()(回合边界快照回调)与 guard(未消费 Flow 检测);
 *  - 增加 AnyEventDraft / AnyRequestDraft 联合,让 runEvent / ask 能从字面量推断 kind;
 *  - 增加 TIMINGS 运行时常量,供 registry 校验 timings。
 */

// ═══════════════════════════ 0. 基础标识与常量 ═══════════════════════════

/** 座位号 0..n-1,同时是 state.players 的下标与玩家唯一标识 */
export type PlayerId = number
/** 实体牌 id = 静态牌表(Registry.deck)的下标,整局不变 */
export type CardId = number
/** 牌名键,与 docs/data/standard-deck.md 的英文 id 一致:'slash' | 'jink' | 'peach' | 'nullification' … */
export type CardName = string
/** 技能 id,与 docs/data/standard-generals.md 一致;装备技能用 'equip.<cardName>' 前缀 */
export type SkillId = string
/** 武将 id,与 docs/data/standard-generals.md 一致 */
export type GeneralId = string
/** 事件 id,由 state.nextEventId 分配,整局唯一 */
export type EventId = number
/** 请求 id,由 state.nextRequestId 分配,整局唯一 */
export type RequestId = number

/** 花色 */
export type Suit = 'spade' | 'heart' | 'club' | 'diamond'
/** 颜色:黑桃 / 梅花为黑,红桃 / 方块为红 */
export type Color = 'black' | 'red'
/** 身份;M1 无身份模式恒为 none */
export type Role = 'lord' | 'loyalist' | 'rebel' | 'renegade' | 'none'
/** 势力 */
export type Kingdom = 'wei' | 'shu' | 'wu' | 'qun'
/** 性别 */
export type Gender = 'male' | 'female'
/** 伤害属性 */
export type Nature = 'normal' | 'fire' | 'thunder'

/** 回合六阶段:准备 / 判定 / 摸牌 / 出牌 / 弃牌 / 结束 */
export type Phase = 'prepare' | 'judge' | 'draw' | 'play' | 'discard' | 'finish'
/** 六阶段的固定顺序 */
export const PHASES: readonly Phase[] = ['prepare', 'judge', 'draw', 'play', 'discard', 'finish']

/** 牌的类型(装备不细分槽位,槽位见 CardDef.equip.slot) */
export type CardType = 'basic' | 'trick' | 'delayed_trick' | 'equip'
/** 装备槽位 */
export type EquipSlot = 'weapon' | 'armor' | 'horse_offensive' | 'horse_defensive'
/** 装备槽位的固定顺序:技能收集、视图展示都按此顺序,保证确定性 */
export const EQUIP_SLOTS: readonly EquipSlot[] = [
  'weapon',
  'armor',
  'horse_offensive',
  'horse_defensive',
]

/** "无限次"的数值表示。禁止 Infinity 进入状态或协议(JSON 会把它变成 null) */
export const UNLIMITED = 1_000_000
/** GameState 结构版本;存档/回放头部携带,不一致即拒绝恢复 */
export const STATE_SCHEMA_VERSION = 1

/** 纯 JSON 值:状态、日志、标记的唯一允许形态 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// ═══════════════════════════ 1. 牌 ═══════════════════════════

/** 牌堆数据条目,字段与 docs/data/standard-deck.md §7 的 JSON 完全一致(可直接 import) */
export interface DeckEntry {
  name: CardName
  zh: string
  kind:
    'basic' | 'trick' | 'delayed_trick' | 'weapon' | 'armor' | 'horse_offensive' | 'horse_defensive'
  suit: Suit
  rank: number
  extra?: { range?: number; distance?: number; ex?: boolean }
}

/** 静态牌表中的一张实体牌:由 DeckEntry 派生,对局中不变,不进 GameState */
export interface CardSpec {
  id: CardId
  name: CardName
  suit: Suit
  number: number // 1..13
  /** 由 DeckEntry.kind 派生(weapon / armor / horse_* → 'equip'),供 CardPattern.types 匹配 */
  type: CardType
}

/**
 * 结算中"被使用 / 打出"的牌。
 * M1 恒为 subcards.length === 1 的实体牌;转化技(武圣 / 龙胆,M3)与"视为使用"(八卦阵,M2)
 * 产出 subcards.length !== 1 的虚拟牌,引擎代码不变。
 */
export interface CardFace {
  name: CardName
  suit: Suit | 'none'
  number: number // 0 = 无点数
  subcards: CardId[]
  viewAs: SkillId | null // 由哪个技能转化而来
}

/** 牌的匹配模式:AskCard 的响应要求、判定条件、ViewAs 的输入过滤共用。纯数据,可进 Request */
export interface CardPattern {
  names: CardName[] | null
  suits: Suit[] | null
  colors: Color[] | null
  numberRange: [number, number] | null
  types: CardType[] | null
  /** 允许从哪些区域选(仅对 AskCard / 选牌有意义),默认 ['hand'] */
  zones: Array<'hand' | 'equip'> | null
}

/** 牌所在的区域 */
export type Zone =
  | { kind: 'hand'; player: PlayerId }
  | { kind: 'equip'; player: PlayerId }
  | { kind: 'judge'; player: PlayerId }
  | { kind: 'draw' }
  | { kind: 'discard' }
  | { kind: 'processing' }

/** 移牌原因 */
export type MoveReason =
  | 'draw'
  | 'use'
  | 'respond'
  | 'discard'
  | 'equip'
  | 'unequip'
  | 'judge'
  | 'retrial'
  | 'delayed_trick'
  | 'give'
  | 'obtain'
  | 'reshuffle'
  | 'bury'
  | 'skill'

/** 一次已完成的移牌(from 由引擎填充);一条 CardsMove 事件可含多条 */
export interface CardMove {
  card: CardId
  from: Zone
  to: Zone
  reason: MoveReason
  /** 进入目标区域的位置:牌堆顶 / 牌堆底(仅对 to.kind === 'draw' 有意义;其余区域总是 'top' = 数组末尾) */
  position: 'top' | 'bottom'
  /** 该移动对谁可见(日志 / 视图据此遮蔽 card);null = 公开 */
  visibleTo: PlayerId[] | null
}

/** moveCards 的入参:from / visibleTo 由引擎推导,position 缺省 'top' */
export interface CardMoveDraft {
  card: CardId
  to: Zone
  reason: MoveReason
  position?: 'top' | 'bottom'
}

// ═══════════════════════════ 2. 玩家与对局状态 ═══════════════════════════

/** 玩家状态(纯数据) */
export interface PlayerState {
  id: PlayerId
  general: GeneralId
  /** 从 GeneralDef 冗余写入:技能(护驾 / 救援 / 结姻)与视图直接读状态,不查 registry */
  kingdom: Kingdom
  gender: Gender
  role: Role
  /** 身份是否已公开(主公开局即公开;其他人死亡后公开) */
  roleRevealed: boolean
  hp: number
  maxHp: number
  alive: boolean
  hand: CardId[]
  /** 四个装备槽;不变量只计非 null 项 */
  equips: Record<EquipSlot, CardId | null>
  /** 判定区:末尾 = 最后放置 = 最先判定 */
  judgeArea: CardId[]
  /** 武将技能(含被赋予的技能);装备技能由 equips 现算,不在此列 */
  skills: SkillId[]
  /**
   * 技能私有标记(不进视图)。生命周期由 key 后缀约定:
   *  '<name>@turn'  回合结束时由引擎清除;'<name>@phase' 阶段结束时清除;其余持久。
   * 只做 key 读写、不遍历(避免对象键序影响确定性)。
   */
  flags: Record<string, JsonValue>
  /** 公开标记(进视图,UI 可显示),同样的 @turn / @phase 生命周期约定 */
  marks: Record<string, number>
}

/** 使用(use)/ 打出(play) */
export type CardUseMode = 'use' | 'play'
/** 一次 CardUse 的发起原因:'play' = 出牌阶段 play 请求;'response' = 响应询问(AskCard);'skill' = 技能令其使用 */
export type UseReason = 'play' | 'response' | 'skill'

/** 一次使用 / 打出的记录(turn.history) */
export interface CardUseRecord {
  player: PlayerId
  card: CardName
  mode: CardUseMode
  reason: UseReason
  phase: Phase | null
}

/** 当前回合的状态 */
export interface TurnState {
  player: PlayerId
  phase: Phase | null
  /** 本回合要跳过的阶段(乐不思蜀在判定阶段写入 'play');进入阶段前读取 */
  skipPhases: Phase[]
  /** 本回合使用 / 打出牌的记录:出杀次数、克己等查询用;回合结束清空 */
  history: CardUseRecord[]
  /** 技能计数('rende:given@phase' 等),同 @turn / @phase 生命周期约定 */
  counters: Record<string, number>
}

/** 对局结果;winners 为空表示平局 */
export interface GameResult {
  winners: PlayerId[]
  reason: string
}

/** 对局阶段:开局前 / 进行中 / 已结束 */
export type GamePhase = 'setup' | 'running' | 'over'

/** 对局状态:纯数据;JSON 往返无损;stateHash 的输入 */
export interface GameState {
  schemaVersion: number
  seed: number
  /** mulberry32 的 32 位状态,每次取随机数后写回 */
  rng: number
  mode: string
  phase: GamePhase
  players: PlayerState[]
  /** 末尾 = 牌堆顶 */
  drawPile: CardId[]
  /** 末尾 = 最新弃置 */
  discardPile: CardId[]
  /** 处理区:正在使用 / 打出 / 判定中的牌 */
  processing: CardId[]
  turn: TurnState | null
  turnCount: number
  lastTurnPlayer: PlayerId | null
  /** 额外回合队列(M3);为空则按座位序取 lastTurnPlayer 之后的下一名存活者 */
  turnQueue: PlayerId[]
  /** 结算栈镜像:栈底为最外层事件;只含正在结算的事件;事件间只有 id 引用 */
  stack: GameEvent[]
  nextEventId: EventId
  nextRequestId: RequestId
  /** 全局标记,同 @turn / @phase 生命周期约定 */
  flags: Record<string, JsonValue>
  result: GameResult | null
}

// ═══════════════════════════ 3. 事件 ═══════════════════════════

/** 所有事件的公共字段 */
export interface EventBase<K extends string> {
  kind: K
  id: EventId
  parentId: EventId | null
  /** 任一时机的技能可置 true;handler 在每个 stage() 后检查并提前返回 */
  cancelled: boolean
  /** 技能之间互通的扩展袋(如 'luoyi:boosted');核心 handler 不读它 */
  tags: Record<string, JsonValue>
}

/** 开局事件 */
export type GameStartEvent = EventBase<'GameStart'>

/** 回合事件 */
export interface TurnEvent extends EventBase<'Turn'> {
  player: PlayerId
}

/** 阶段事件 */
export interface PhaseEvent extends EventBase<'Phase'> {
  player: PlayerId
  phase: Phase
  /** 被 skipPhases 或 Phase.before 的取消跳过 */
  skipped: boolean
}

/** 摸牌事件 */
export interface DrawCardsEvent extends EventBase<'DrawCards'> {
  player: PlayerId
  /** DrawCards.before 时机可修改(英姿 +1、裸衣 −1)或取消(突袭) */
  count: number
  reason: 'initial' | 'phase' | 'skill' | 'reward'
  /** 实际摸到的牌,摸完后填入 */
  cards: CardId[]
}

/** 移牌事件(一次可含多条移动,原子应用) */
export interface CardsMoveEvent extends EventBase<'CardsMove'> {
  moves: CardMove[]
}

/** AskCard 的结果快照(纯数据,不指向已出栈的子事件) */
export interface AskCardResult {
  responded: boolean
  /** 实际使用 / 打出的牌(含虚拟牌);未响应为 null */
  card: CardFace | null
}

/**
 * 询问玩家使用 / 打出一张符合 pattern 的牌。本身是事件:
 *  AskCard.before 时机的技能可直接写 result.responded = true(八卦阵、护驾)或置 cancelled(铁骑)跳过询问。
 */
export interface AskCardEvent extends EventBase<'AskCard'> {
  player: PlayerId
  pattern: CardPattern
  mode: CardUseMode
  /** 使用时的固定目标(濒死求桃 = [濒死者];借刀 = [指定目标]);优先于 CardDef.target.auto */
  targets: PlayerId[]
  /** 响应的对象:闪 → 杀的 CardEffect;无懈 → 锦囊的 CardEffect */
  againstId: EventId | null
  /** 引发询问的事件(濒死求桃 → Dying) */
  reasonId: EventId | null
  prompt: Prompt
  result: AskCardResult
}

/** 使用牌事件 */
export interface CardUseEvent extends EventBase<'CardUse'> {
  source: PlayerId
  card: CardFace
  targets: PlayerId[]
  /** 逐目标时机(targeted / targetSpecified / targetConfirmed)执行期间指向当前目标 */
  currentTarget: PlayerId | null
  reason: UseReason
  againstId: EventId | null
  /** 本次使用能否被无懈可击响应(离间的决斗 = false) */
  nullifiable: boolean
  /**
   * 每个目标抵消此牌所需的响应张数,key = String(PlayerId);缺省由 fold('requiredResponses') 计算。
   * 0 = 不可响应(铁骑);2 = 需两张(无双)。创建 CardEffect 时复制到 requiredResponses。
   */
  responseCounts: Record<string, number>
}

/** 打出一张牌(决斗 / 南蛮要求的杀、借刀之外的打出);不产生 CardEffect */
export interface CardRespondEvent extends EventBase<'CardRespond'> {
  player: PlayerId
  card: CardFace
  againstId: EventId | null
  reasonId: EventId | null
}

/** 一张牌对一个目标的一次生效;无懈、仁王盾"牌无效"、多目标逐个结算的作用单位 */
export interface CardEffectEvent extends EventBase<'CardEffect'> {
  /** 所属 CardUse;延时锦囊判定阶段生效时为 null */
  useId: EventId | null
  card: CardFace
  source: PlayerId | null
  /** 零目标牌(无懈、闪)为 null;此时该 CardUse 恰产生一个 target=null 的 CardEffect */
  target: PlayerId | null
  /** 延时锦囊在判定阶段的生效 */
  delayed: boolean
  nullifiable: boolean
  /** 被无懈可击抵消 */
  nullified: boolean
  /** 被修正技判定为"无效"(仁王盾),与 nullified 区分以便日志 / 技能判断 */
  voided: boolean
  /** 目标以响应牌抵消(杀被闪):由卡牌效果写入,青龙偃月刀 / 贯石斧在 CardEffect.after 读取 */
  responded: boolean
  /** 抵消此效果所需响应张数(0 = 不可响应) */
  requiredResponses: number
}

/** 伤害事件 */
export interface DamageEvent extends EventBase<'Damage'> {
  from: PlayerId | null
  to: PlayerId
  /** Damage.caused / Damage.inflicted 时机可修改;≤ 0 视为防止 */
  amount: number
  nature: Nature
  /** 造成伤害的牌(冗余自 cause,技能最常读的字段) */
  card: CardFace | null
  /** 导致伤害的 CardEffect(或 null:闪电 / 技能) */
  causeId: EventId | null
}

/** 失去体力事件 */
export interface LoseHpEvent extends EventBase<'LoseHp'> {
  player: PlayerId
  amount: number
  reasonId: EventId | null
}

/** 回复体力事件 */
export interface RecoverEvent extends EventBase<'Recover'> {
  to: PlayerId
  /** Recover.before 时机可修改(救援 +1) */
  amount: number
  source: PlayerId | null
  card: CardFace | null
  causeId: EventId | null
}

/** 濒死事件 */
export interface DyingEvent extends EventBase<'Dying'> {
  player: PlayerId
  /** 导致濒死的 Damage(失去体力进入濒死时为 null) */
  damageId: EventId | null
}

/** 死亡事件 */
export interface DeathEvent extends EventBase<'Death'> {
  player: PlayerId
  killer: PlayerId | null
  damageId: EventId | null
}

/** 判定事件 */
export interface JudgeEvent extends EventBase<'Judge'> {
  player: PlayerId
  /** 'indulgence' | 'lightning' | 'eight_diagram' | 技能 id */
  reason: string
  pattern: CardPattern
  /** 翻出后填入;改判(Judge.cardShown 时机)替换 */
  card: CardId | null
  matched: boolean | null
  retrialBy: PlayerId[]
}

/** 全部事件种类的联合 */
export type GameEvent =
  | GameStartEvent
  | TurnEvent
  | PhaseEvent
  | DrawCardsEvent
  | CardsMoveEvent
  | AskCardEvent
  | CardUseEvent
  | CardRespondEvent
  | CardEffectEvent
  | DamageEvent
  | LoseHpEvent
  | RecoverEvent
  | DyingEvent
  | DeathEvent
  | JudgeEvent

/** 事件种类 */
export type EventKind = GameEvent['kind']
/** 按 kind 取事件类型 */
export type EventOf<K extends EventKind> = Extract<GameEvent, { kind: K }>
/** runEvent 的入参:省略引擎自动填充的字段 */
export type EventDraft<E extends GameEvent> = Omit<E, 'id' | 'parentId' | 'cancelled' | 'tags'>
/** 全部事件草案的联合:runEvent 据此从字面量的 kind 推断返回的事件类型 */
export type AnyEventDraft = { [K in EventKind]: EventDraft<EventOf<K>> }[EventKind]

/**
 * 时机点 → 事件类型 的映射。Timing 由它派生,所以:
 *  - 新增时机 = 在此加一行(内容包可用 declare module 合并声明自定义时机,如 'Slash.missed');
 *  - TriggerSkill<T> 的 canTrigger / effect 自动按时机收窄事件类型,技能代码无需 cast。
 * 各时机在 handler 中的触发顺序见 ENGINE_DESIGN.md §3.2,并由快照测试锁住。
 */
export interface TimingEventMap {
  'Game.start': GameStartEvent
  'Turn.start': TurnEvent
  'Turn.end': TurnEvent
  'Phase.before': PhaseEvent
  'Phase.skipped': PhaseEvent
  'Phase.start': PhaseEvent
  'Phase.end': PhaseEvent
  'DrawCards.before': DrawCardsEvent
  'DrawCards.after': DrawCardsEvent
  'CardsMove.before': CardsMoveEvent
  'CardsMove.after': CardsMoveEvent
  'AskCard.before': AskCardEvent
  'AskCard.after': AskCardEvent
  'CardUse.before': CardUseEvent
  'CardUse.targeting': CardUseEvent
  'CardUse.targeted': CardUseEvent
  'CardUse.targetSpecified': CardUseEvent
  'CardUse.targetConfirmed': CardUseEvent
  'CardUse.using': CardUseEvent
  'CardUse.after': CardUseEvent
  'CardRespond.before': CardRespondEvent
  'CardRespond.after': CardRespondEvent
  'CardEffect.before': CardEffectEvent
  'CardEffect.nullified': CardEffectEvent
  'CardEffect.after': CardEffectEvent
  'Damage.caused': DamageEvent
  'Damage.inflicted': DamageEvent
  'Damage.done': DamageEvent
  'Damage.after': DamageEvent
  'LoseHp.before': LoseHpEvent
  'LoseHp.after': LoseHpEvent
  'Recover.before': RecoverEvent
  'Recover.after': RecoverEvent
  'Dying.enter': DyingEvent
  'Dying.after': DyingEvent
  'Death.before': DeathEvent
  'Death.after': DeathEvent
  'Judge.before': JudgeEvent
  'Judge.cardShown': JudgeEvent
  'Judge.result': JudgeEvent
  'Judge.after': JudgeEvent
}
/** 时机点(由 TimingEventMap 的键派生,拼错即编译错误) */
export type Timing = keyof TimingEventMap

/** 全部时机的运行时表(与 TimingEventMap 一一对应,缺项即编译错误),供 registry 校验 */
const TIMING_TABLE: Record<Timing, true> = {
  'Game.start': true,
  'Turn.start': true,
  'Turn.end': true,
  'Phase.before': true,
  'Phase.skipped': true,
  'Phase.start': true,
  'Phase.end': true,
  'DrawCards.before': true,
  'DrawCards.after': true,
  'CardsMove.before': true,
  'CardsMove.after': true,
  'AskCard.before': true,
  'AskCard.after': true,
  'CardUse.before': true,
  'CardUse.targeting': true,
  'CardUse.targeted': true,
  'CardUse.targetSpecified': true,
  'CardUse.targetConfirmed': true,
  'CardUse.using': true,
  'CardUse.after': true,
  'CardRespond.before': true,
  'CardRespond.after': true,
  'CardEffect.before': true,
  'CardEffect.nullified': true,
  'CardEffect.after': true,
  'Damage.caused': true,
  'Damage.inflicted': true,
  'Damage.done': true,
  'Damage.after': true,
  'LoseHp.before': true,
  'LoseHp.after': true,
  'Recover.before': true,
  'Recover.after': true,
  'Dying.enter': true,
  'Dying.after': true,
  'Death.before': true,
  'Death.after': true,
  'Judge.before': true,
  'Judge.cardShown': true,
  'Judge.result': true,
  'Judge.after': true,
}
/** 全部时机(声明序);仅用于校验与测试夹具,引擎不按它排序 */
export const TIMINGS: readonly Timing[] = Object.keys(TIMING_TABLE) as Timing[]

// ═══════════════════════════ 4. Request / Response(唯一交互出口) ═══════════════════════════

/** 可本地化的提示文案:引擎只给 key 与参数,文案由客户端渲染 */
export interface Prompt {
  key: string
  args: Record<string, string | number>
}

/** 目标选择约束:候选集由引擎算好,客户端不需要懂规则 */
export interface TargetSpec {
  candidates: PlayerId[]
  min: number
  max: number
}

/** 选牌约束(本人的牌) */
export interface CardSelection {
  candidates: CardId[]
  min: number
  max: number
}

/** 出牌阶段可使用的牌及其目标约束 */
export interface UsableCard {
  card: CardId
  targets: TargetSpec
}

/** 出牌阶段可发动的技能及其选牌 / 选目标约束 */
export interface UsableSkill {
  skill: SkillId
  kind: 'active' | 'viewAs'
  /** 转化技:转化成哪张牌(同一技能可产出多种牌时每种一条);主动技为 null */
  as: CardName | null
  cards: CardSelection
  targets: TargetSpec
}

/** 选牌候选:他人手牌等不可见的牌只给 index,card 为 null */
export interface ChooseCardCandidate {
  index: number
  card: CardId | null
  zone: Zone
}

/** arrange 请求的槽位约束 */
export interface ArrangeSlot {
  id: string
  min: number
  max: number
}

/** 所有请求的公共字段 */
export interface RequestBase<K extends string> {
  kind: K
  id: RequestId
  player: PlayerId
  prompt: Prompt
  /** 引发询问的事件 id(客户端可在 PlayerView.stack 中找到其摘要) */
  reason: EventId | null
}

/** 出牌阶段:使用牌 / 发动技能 / 结束 */
export interface PlayRequest extends RequestBase<'play'> {
  usableCards: UsableCard[]
  usableSkills: UsableSkill[]
}

/** 响应询问:使用 / 打出一张符合 pattern 的牌(闪、桃、无懈、决斗的杀 …) */
export interface AskCardRequest extends RequestBase<'askCard'> {
  pattern: CardPattern
  mode: CardUseMode
  /** 本人符合 pattern 的实体牌 */
  candidates: CardId[]
  /** 可转化出该牌的技能(M3)及其选牌约束 */
  viewAsSkills: Array<{ skill: SkillId; cards: CardSelection }>
  /** 固定目标(引擎已定,玩家不选) */
  fixedTargets: PlayerId[]
  /** 需要玩家选目标时给出(借刀杀人令其使用杀);null = 无需选 */
  targets: TargetSpec | null
  against: EventId | null
}

/** 选牌请求:弃牌、技能选牌、过河拆桥 / 顺手牵羊的盲位选牌 */
export interface ChooseCardsRequest extends RequestBase<'chooseCards'> {
  candidates: ChooseCardCandidate[]
  min: number
  max: number
  cancellable: boolean
}

/** 选人请求(M3 技能选人) */
export interface ChoosePlayersRequest extends RequestBase<'choosePlayers'> {
  candidates: PlayerId[]
  min: number
  max: number
  cancellable: boolean
}

/** 多选一请求 */
export interface ChoiceRequest extends RequestBase<'choice'> {
  options: string[]
  cancellable: boolean
}

/** 是否发动 / 先发动哪个触发技:skills 长度 1 = 是否发动;>1 = 选一个先发动 */
export interface InvokeSkillRequest extends RequestBase<'invokeSkill'> {
  skills: SkillId[]
  event: EventId
}

/** 排列牌(观星:分到牌堆顶 / 底并排序) */
export interface ArrangeRequest extends RequestBase<'arrange'> {
  cards: CardId[]
  slots: ArrangeSlot[]
}

/** 全部请求种类的联合 */
export type Request =
  | PlayRequest
  | AskCardRequest
  | ChooseCardsRequest
  | ChoosePlayersRequest
  | ChoiceRequest
  | InvokeSkillRequest
  | ArrangeRequest

/** 请求种类 */
export type RequestKind = Request['kind']
/** 按 kind 取请求类型 */
export type RequestOf<K extends RequestKind> = Extract<Request, { kind: K }>
/** ask() 的入参:id 由引擎分配 */
export type RequestDraft<K extends RequestKind> = Omit<RequestOf<K>, 'id'>
/** 全部请求草案的联合:ask 据此从字面量的 kind 推断应答类型 */
export type AnyRequestDraft = { [K in RequestKind]: RequestDraft<K> }[RequestKind]

/** 所有应答的公共字段 */
export interface ResponseBase<K extends RequestKind> {
  kind: K
  requestId: RequestId
}

/** 出牌阶段的动作:使用牌 / 发动技能 / 结束 */
export type PlayAction =
  | { action: 'useCard'; card: CardId; targets: PlayerId[] }
  | {
      action: 'useSkill'
      skill: SkillId
      as: CardName | null
      cards: CardId[]
      targets: PlayerId[]
    }
  | { action: 'end' }

/** play 请求的应答 */
export type PlayResponse = ResponseBase<'play'> & PlayAction

/** askCard 请求的应答 */
export interface AskCardResponse extends ResponseBase<'askCard'> {
  /** null = 不响应(取消) */
  card: CardId | null
  /** 以转化技响应时给出;与 card 二选一 */
  viewAs: { skill: SkillId; cards: CardId[] } | null
  /** 仅当请求 targets !== null 时有意义 */
  targets: PlayerId[]
}

/** chooseCards 请求的应答 */
export interface ChooseCardsResponse extends ResponseBase<'chooseCards'> {
  /** 以 candidates 的 index 回传,他人手牌不暴露 id */
  indices: number[]
}

/** choosePlayers 请求的应答 */
export interface ChoosePlayersResponse extends ResponseBase<'choosePlayers'> {
  players: PlayerId[]
}

/** choice 请求的应答 */
export interface ChoiceResponse extends ResponseBase<'choice'> {
  option: string
}

/** invokeSkill 请求的应答 */
export interface InvokeSkillResponse extends ResponseBase<'invokeSkill'> {
  /** null = 不发动 */
  skill: SkillId | null
}

/** arrange 请求的应答 */
export interface ArrangeResponse extends ResponseBase<'arrange'> {
  /** slotId → 有序牌列表;所有 cards 必须恰好出现一次 */
  placement: Record<string, CardId[]>
}

/** 全部应答种类的联合 */
export type Response =
  | PlayResponse
  | AskCardResponse
  | ChooseCardsResponse
  | ChoosePlayersResponse
  | ChoiceResponse
  | InvokeSkillResponse
  | ArrangeResponse

/** 按 kind 取应答类型 */
export type ResponseOf<K extends RequestKind> = Extract<Response, { kind: K }>

// ═══════════════════════════ 5. 流程(生成器协程)、上下文、选项 ═══════════════════════════

/**
 * 引擎内所有可能询问玩家的函数的返回类型:yield 出 Request,收到 Response 后继续,最终返回 T。
 * 调用方必须写 `yield* f(...)`;漏写会静默不执行,由 lint 规则 flow-must-be-consumed 与
 * EngineOptions.detectUnconsumedFlows 的运行时检测双重兜底。
 */
export type Flow<T> = Generator<Request, T, Response>

/** 引擎选项:随 GameConfig 保存进快照,回放时一致 */
export interface EngineOptions {
  /** 每个事件出栈、每个 Request 等待点断言总牌数不变量(测试 / 模拟器打开) */
  assertInvariants: boolean
  /** 检测"创建了 Flow 却未 yield*"(开发 / 测试打开) */
  detectUnconsumedFlows: boolean
  /** 超过则判平局结束,防止死循环 */
  maxTurns: number
  /** 结算栈深度上限,超过视为引擎错误(技能互相触发死循环) */
  maxStackDepth: number
  /** 非法应答:'throw' = 抛错且生成器不前进(Runner 可重发);'default' = 按 defaultResponse 处理并记录 */
  invalidResponsePolicy: 'throw' | 'default'
  /** 无懈被无懈抵消后,是否就原效果重新询问一轮(QSanguosha / FreeKill 口径 = true) */
  reopenNullification: boolean
}

/** 对局配置:种子、模式、玩家、测试用固定牌序与引擎选项 */
export interface GameConfig {
  seed: number
  mode: string
  /** general 为 null 时由模式分配(M1:固定占位武将) */
  players: Array<{ general: GeneralId | null }>
  /** 测试用:指定牌堆顺序(末尾为顶)代替洗牌;null = 用种子洗牌 */
  fixedDeckOrder: CardId[] | null
  options: Partial<EngineOptions>
}

/** 对局日志条目:不是状态,不进 stateHash */
export interface LogEntry {
  seq: number
  /** 'draw' | 'cardsMove' | 'useCard' | 'damage' | 'phase' | 'skillInvoked' | … */
  type: string
  /** 纯数据快照;禁止放事件对象引用(事件后续被突变会追溯改变日志) */
  data: JsonValue
  /** null = 公开;否则只有列出的玩家可见 */
  visibleTo: PlayerId[] | null
  eventId: EventId | null
}
/** 写日志的入参(seq 由 Game 分配) */
export type LogDraft = Omit<LogEntry, 'seq'>

/**
 * 未消费 Flow 检测器(运行期对象,不进状态)。
 * 工厂函数创建生成器时 create() 登记 token,生成器体第一行 consume() 注销;
 * 事件出栈与每个 Request 等待点 check(),仍有未注销 token 即抛 EngineError。
 */
export interface FlowGuard {
  create(label: string): number
  consume(token: number): void
  check(where: string): void
}

/** 传给所有 handler / 技能 / 卡牌钩子的上下文。运行期对象,不进状态 */
export interface Ctx {
  readonly state: GameState
  readonly registry: Registry
  readonly config: GameConfig
  readonly options: EngineOptions
  readonly handlers: EventHandlers
  readonly guard: FlowGuard
  /** 写对局日志(进 Game.log,不进 state) */
  log(entry: LogDraft): void
  /** 唯一随机源:读写 state.rng */
  random(): number
  randomInt(n: number): number
  shuffle<T>(items: T[]): void
  /** 顶层循环每次进入 Turn 前调用(此时结算栈为空):Game 在此克隆回合边界快照 */
  onTurnBoundary(): void
}

/** 事件 handler 签名 */
export type EventHandler<E extends GameEvent> = (ctx: Ctx, ev: E) => Flow<void>
/** 事件种类 → handler 的表 */
export type EventHandlers = { [K in EventKind]: EventHandler<EventOf<K>> }

// ═══════════════════════════ 6. 技能定义(registry) ═══════════════════════════

/** 技能定义的公共字段 */
export interface SkillBase {
  id: SkillId
  name: string
  description: string
  /** 锁定技:触发时不询问、必发动;修正技恒为 true */
  locked: boolean
  /** 主公技:仅 mode.lordSkillsEnabled() 为真时参与收集 */
  lord: boolean
}

/**
 * 触发技。T 为该技能关心的时机集合;canTrigger / effect 的 ev 自动收窄为对应事件类型。
 * 方法签名(而非属性箭头函数)使 TriggerSkill<'Damage.done'> 可赋给 TriggerSkill<Timing>。
 */
export interface TriggerSkill<T extends Timing = Timing> extends SkillBase {
  type: 'trigger'
  timings: readonly T[]
  /** 跨玩家优先级桶,大者先;默认 0。规则类技能(身份局奖惩等)用正数,"最后结算"用负数 */
  priority: number
  /** 拥有者死亡后仍可触发(默认 false) */
  triggerWhenDead: boolean
  canTrigger(ctx: Ctx, ev: TimingEventMap[T], owner: PlayerId): boolean
  /** 同一事件同一时机最多发动次数(遗计 = 伤害点数);缺省 1 */
  times?(ctx: Ctx, ev: TimingEventMap[T], owner: PlayerId): number
  effect(ctx: Ctx, ev: TimingEventMap[T], owner: PlayerId): Flow<void>
}

/** 修正钩子:对 value 做一次折叠并返回新值;必须是纯函数(不改状态、不询问) */
export type ModifierHook<V, A extends unknown[]> = (
  ctx: Ctx,
  owner: PlayerId,
  value: V,
  ...args: A
) => V

/**
 * 修正钩子表。内容包可用 declare module 合并声明新钩子,核心只认识 fold()。
 * 折叠顺序:座位 0 起 + skillsOf 顺序,固定且确定;钩子应写成与顺序无关(加减 / 或 / 取极值)。
 */
export interface ModifierHooks {
  /** 攻击范围;base = 武器 range 或 1 */
  attackRange: ModifierHook<number, [subject: PlayerId]>
  /** from 视角的距离修正(−1 马、马术) */
  distanceFrom: ModifierHook<number, [from: PlayerId, to: PlayerId]>
  /** to 视角的距离修正(+1 马) */
  distanceTo: ModifierHook<number, [from: PlayerId, to: PlayerId]>
  /** 出牌阶段使用某牌的次数上限;base:杀 = 1,其余 UNLIMITED(诸葛连弩 / 咆哮 → UNLIMITED) */
  useLimit: ModifierHook<number, [subject: PlayerId, card: CardFace]>
  /** 手牌上限;base = hp */
  maxHandCards: ModifierHook<number, [subject: PlayerId]>
  /** 使用该牌无距离限制(奇才) */
  ignoreDistance: ModifierHook<boolean, [subject: PlayerId, card: CardFace]>
  /** 额外目标数(方天画戟) */
  extraTargets: ModifierHook<number, [subject: PlayerId, card: CardFace]>
  /** 不能成为目标(空城、谦逊) */
  prohibitTarget: ModifierHook<boolean, [source: PlayerId, target: PlayerId, card: CardFace]>
  /** 牌对 owner 无效(仁王盾);在 CardEffect 生效前查询 */
  nullifyEffect: ModifierHook<boolean, [effect: CardEffectEvent]>
  /** 抵消此牌所需响应张数;base = 1(无双 → 2) */
  requiredResponses: ModifierHook<number, [use: CardUseEvent, target: PlayerId]>
}
/** 修正钩子的键 */
export type ModifierKey = keyof ModifierHooks
/** 钩子的值类型(= 返回类型) */
export type HookValue<K extends ModifierKey> = ReturnType<ModifierHooks[K]>
/** 钩子的额外参数类型(ctx、owner、value 之后的部分) */
export type HookArgs<K extends ModifierKey> =
  Parameters<ModifierHooks[K]> extends [Ctx, PlayerId, unknown, ...infer A] ? A : never
/** core/modifiers.ts 的 fold() 签名:按座位序折叠所有玩家(含装备)的修正钩子 */
export type FoldFn = <K extends ModifierKey>(
  ctx: Ctx,
  hook: K,
  base: HookValue<K>,
  ...args: HookArgs<K>
) => HookValue<K>

/** 修正技:纯函数折叠,不触发、不询问;恒为锁定技 */
export interface ModifierSkill extends SkillBase {
  type: 'modifier'
  modifiers: Partial<ModifierHooks>
}

/** 主动技(M3):出牌阶段由 play 请求的 useSkill 触发 */
export interface ActiveSkill extends SkillBase {
  type: 'active'
  /** 含"每阶段限一次"等条件(读 turn.counters) */
  canUse(ctx: Ctx, owner: PlayerId): boolean
  cards: {
    min: number
    max: number
    filter(ctx: Ctx, owner: PlayerId, card: CardId, selected: CardId[]): boolean
  }
  targets: {
    min: number
    max: number
    filter(ctx: Ctx, owner: PlayerId, target: PlayerId, selected: PlayerId[]): boolean
  }
  effect(ctx: Ctx, owner: PlayerId, cards: CardId[], targets: PlayerId[]): Flow<void>
}

/** 转化技(M3):把若干牌视为一张牌使用 / 打出(武圣 / 龙胆 / 倾国 / 奇袭 / 国色 / 急救) */
export interface ViewAsSkill extends SkillBase {
  type: 'viewAs'
  /** 可转化出的牌名;引擎据此枚举 PlayRequest.usableSkills 与 AskCard 的 viewAsSkills */
  produces: CardName[]
  cardCount: [number, number]
  enabledAtPlay(ctx: Ctx, owner: PlayerId, as: CardName): boolean
  enabledAtResponse(ctx: Ctx, owner: PlayerId, pattern: CardPattern, mode: CardUseMode): boolean
  cardFilter(ctx: Ctx, owner: PlayerId, card: CardId, selected: CardId[], as: CardName): boolean
  /** 返回虚拟牌(viewAs = 本技能 id);不合法返回 null */
  viewAs(ctx: Ctx, owner: PlayerId, cards: CardId[], as: CardName): CardFace | null
}

/** 全部技能定义的联合 */
export type SkillDef = TriggerSkill | ModifierSkill | ActiveSkill | ViewAsSkill

// ═══════════════════════════ 7. 牌、武将、模式定义(registry) ═══════════════════════════

/** 牌的目标规则:数量、自动填充、距离限制与额外过滤 */
export interface TargetRule {
  min: number
  max: number | 'all'
  /** 引擎自动填目标、玩家不选:桃 / 装备 = 'self',万箭 / 南蛮 = 'allOthers',桃园 = 'all' */
  auto: 'self' | 'allOthers' | 'all' | null
  /** 距离限制:'attack' = 攻击范围内(杀);数字 = 距离 ≤ n(顺手牵羊 1);null = 无限制 */
  range: 'attack' | number | null
  excludeSelf: boolean
  /** 额外的目标合法性(方天画戟等依赖已选目标的规则) */
  filter?(ctx: Ctx, user: PlayerId, target: PlayerId, selected: PlayerId[], card: CardFace): boolean
}

/** 牌定义:类型、装备属性、目标规则与效果钩子 */
export interface CardDef {
  name: CardName
  type: CardType
  /** 装备属性;非装备为 null。range = 武器攻击范围;distance = 坐骑修正(−1 / +1);skills 进入装备区即生效 */
  equip: {
    slot: EquipSlot
    range: number | null
    distance: number | null
    skills: SkillId[]
  } | null
  /** 延时锦囊的判定条件;其余为 null */
  judgePattern: CardPattern | null
  target: TargetRule
  /** 能否被无懈可击响应(即时锦囊默认 true;延时锦囊仅判定阶段生效时询问) */
  nullifiable: boolean
  /** 出牌阶段主动使用的额外条件;仅作响应的牌(闪 / 无懈)返回 false */
  canUse?(ctx: Ctx, user: PlayerId, card: CardFace): boolean
  /** 对单个目标生效;无则该牌无效果(闪) */
  effect?(ctx: Ctx, effect: CardEffectEvent): Flow<void>
  /** 效果被无懈 / 无效化后的善后(闪电:移到下家判定区) */
  onNullified?(ctx: Ctx, effect: CardEffectEvent): Flow<void>
}

/** 武将定义 */
export interface GeneralDef {
  id: GeneralId
  name: string
  kingdom: Kingdom
  gender: Gender
  maxHp: number
  /** 声明顺序即同玩家技能的排序依据(不依赖模块加载顺序) */
  skills: SkillId[]
}

/** 模式定义:开局、死亡奖惩、胜负判定与身份可见性 */
export interface ModeDef {
  id: string
  playerCount: [number, number]
  /** 开局:分配身份 / 武将、初始体力、洗牌(或 ctx.config.fixedDeckOrder)、发初始手牌、填 turnQueue(可询问) */
  setup(ctx: Ctx): Flow<void>
  /** 死亡奖惩(身份局:反贼被杀者摸三张,主公杀忠弃全部) */
  onDeath(ctx: Ctx, ev: DeathEvent): Flow<void>
  checkWinner(ctx: Ctx): GameResult | null
  /** viewer 能否看到 target 的身份 */
  roleVisible(ctx: Ctx, viewer: PlayerId, target: PlayerId): boolean
  lordSkillsEnabled(ctx: Ctx, player: PlayerId): boolean
}

/** 只读注册表:实例而非全局单例,核心单测可注入假牌 / 假技能 */
export interface Registry {
  readonly deck: readonly CardSpec[]
  /** 由所有已注册 id + 声明的内容版本号计算,写入存档 / 回放头部 */
  readonly contentHash: string
  spec(card: CardId): CardSpec
  /** 未注册的牌名(M1 的锦囊 / 装备)返回 null:可摸可弃不可使用 */
  card(name: CardName): CardDef | null
  skill(id: SkillId): SkillDef
  general(id: GeneralId): GeneralDef
  mode(id: string): ModeDef
  /** 预建索引:关心某时机的触发技(只读,顺序无意义) */
  triggerSkillsAt(timing: Timing): readonly TriggerSkill[]
  /** 该时机出现过的优先级集合,降序,恒含 0 */
  triggerPriorities(timing: Timing): readonly number[]
}

/** 内容包:一组牌 / 技能 / 武将 / 模式及其版本号(参与 contentHash) */
export interface ContentPackage {
  name: string
  version: string
  cards?: CardDef[]
  skills?: SkillDef[]
  generals?: GeneralDef[]
  modes?: ModeDef[]
}

/** 注册表构建器:setDeck → use → build */
export interface RegistryBuilder {
  setDeck(entries: DeckEntry[]): RegistryBuilder
  use(pkg: ContentPackage): RegistryBuilder
  /** 校验 id 唯一、引用的技能 / 牌存在、timings 合法;之后冻结 */
  build(): Registry
}

// ═══════════════════════════ 8. 视图、控制器、引擎 I/O ═══════════════════════════

/** 他人可见的玩家公开信息(手牌只给数量) */
export interface PublicPlayerView {
  id: PlayerId
  general: GeneralId
  kingdom: Kingdom
  gender: Gender
  hp: number
  maxHp: number
  alive: boolean
  handCount: number
  equips: Record<EquipSlot, CardId | null>
  judgeArea: CardId[]
  /** 'hidden' = 按模式规则对 viewer 不可见 */
  role: Role | 'hidden'
  roleRevealed: boolean
  skills: SkillId[]
  marks: Record<string, number>
}

/** 结算栈中事件的遮蔽摘要:UI 显示"你在响应什么";不含他人手牌 / 询问模式等隐藏信息 */
export interface EventSummary {
  id: EventId
  kind: EventKind
  card: CardFace | null
  source: PlayerId | null
  targets: PlayerId[]
}

/** 玩家视角的视图:只含自己的手牌,他人身份按模式遮蔽 */
export interface PlayerView {
  me: PlayerId
  role: Role
  /** 只有自己的手牌 */
  hand: CardId[]
  players: PublicPlayerView[]
  drawPileCount: number
  discardPile: CardId[]
  processing: CardId[]
  turn: TurnState | null
  turnCount: number
  stack: EventSummary[]
  /** 当前引擎在等谁应答 */
  waitingFor: PlayerId | null
  result: GameResult | null
}

/** 唯一交互出口的另一端:真人 UI / AI / 远程玩家都是它的实现;核心 Game 不认识它,只有 runner 调用 */
export interface PlayerController {
  respond(request: Request, view: PlayerView): Promise<Response> | Response
  /** 可选:每步推进后收到本人视角的视图与可见的新增日志(UI 动画 / AI 记牌) */
  notify?(view: PlayerView, logs: LogEntry[]): void
}

/** start / step 的返回:下一个请求或对局结束,附本步新增的日志 */
export type StepResult =
  | { type: 'request'; request: Request; logs: LogEntry[] }
  | { type: 'over'; result: GameResult; logs: LogEntry[] }

/**
 * 存档 / 回放的统一格式:
 *  - base = null:从 config 开局完整回放 responses(录像,M6);
 *  - base ≠ null:base 是最近一次回合边界(stack 为空)的状态快照,responses 只含该回合内的应答
 *    (中途存档 / 服务端重启恢复,M7)。
 */
export interface Snapshot {
  engineVersion: string
  schemaVersion: number
  contentHash: string
  config: GameConfig
  base: GameState | null
  responses: Response[]
  /** 到 base 为止的日志(仅供 UI 展示,可省略为 []) */
  log: LogEntry[]
}

/** Game 类的公开接口(实现见 core/engine.ts) */
export interface GameApi {
  readonly state: GameState
  readonly log: readonly LogEntry[]
  /** 自开局以来被引擎采纳的全部应答(非法应答按策略替换后才记录) */
  readonly responses: readonly Response[]
  /** 正在等待应答的请求 */
  readonly pending: Request | null
  /** 推进到第一个 Request(或直接结束) */
  start(): StepResult
  /** 校验并喂入一条应答,推进到下一个 Request 或结束;非法应答按 options.invalidResponsePolicy 处理 */
  step(response: Response): StepResult
  viewFor(player: PlayerId): PlayerView
  /** 对 state 做规范化 JSON 后哈希(不含日志);联机校验 / 回放一致性用 */
  stateHash(): string
  snapshot(): Snapshot
}
