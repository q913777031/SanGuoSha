/**
 * 展示层文案:牌名、花色、玩家名、日志与提示的中文渲染。
 * 引擎只给 key 与参数(Prompt / LogEntry),所有中文文案集中在这里。
 */
import type { CardId, LogEntry, PlayerId, Prompt, Request, Suit } from '@sgs/engine'
import { STANDARD_DECK } from '@sgs/engine'

/** 真人玩家固定坐 0 号位 */
export const HUMAN: PlayerId = 0

const SEAT_NAMES = ['你', '乙', '丙', '丁', '戊', '己', '庚', '辛']

/** 座位的显示名 */
export function playerName(p: PlayerId | null | undefined): string {
  if (p === null || p === undefined || p < 0) return '无来源'
  return SEAT_NAMES[p] ?? `${p + 1}号位`
}

export const SUIT_SYMBOL: Record<Suit | 'none', string> = {
  spade: '♠',
  heart: '♥',
  club: '♣',
  diamond: '♦',
  none: '',
}

/** 红色花色(♥ ♦) */
export function isRed(suit: Suit | 'none'): boolean {
  return suit === 'heart' || suit === 'diamond'
}

const RANK_LABEL = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']

/** 点数显示(1 → A,11 → J …) */
export function rankLabel(n: number): string {
  return RANK_LABEL[n] ?? ''
}

const NAME_ZH: Record<string, string> = Object.fromEntries(
  STANDARD_DECK.map((e) => [e.name, e.zh] as const),
)

/** 牌名(英文 id)→ 中文名 */
export function cardNameZh(name: string): string {
  return NAME_ZH[name] ?? name
}

/** 实体牌 id → 牌面信息 */
export function cardInfo(id: CardId): { name: string; zh: string; suit: Suit; rank: number } {
  const e = STANDARD_DECK[id]
  if (!e) throw new Error(`unknown card id ${id}`)
  return { name: e.name, zh: e.zh, suit: e.suit, rank: e.rank }
}

/** M1 只实现了杀 / 闪 / 桃;其他牌在牌堆里但还不能使用 */
export const PLAYABLE_NAMES = new Set(['slash', 'jink', 'peach'])

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}
function num(v: unknown): number {
  return typeof v === 'number' ? v : -1
}
function cardText(v: unknown): string {
  const c = obj(v)
  return typeof c.name === 'string' ? `【${cardNameZh(c.name)}】` : '【?】'
}

/** 把一条日志渲染为中文句子;不需要展示的类型返回 null */
export function formatLog(e: LogEntry): string | null {
  const d = obj(e.data)
  switch (e.type) {
    case 'turnStart':
      return `第 ${num(d.turnCount)} 回合 · ${playerName(num(d.player))}`
    case 'draw':
      return `${playerName(num(d.player))} 摸了 ${num(d.count)} 张牌`
    case 'useCard': {
      const targets = Array.isArray(d.targets) ? d.targets.map((t) => playerName(num(t))) : []
      const who = playerName(num(d.source))
      return targets.length > 0
        ? `${who} 对 ${targets.join('、')} 使用了${cardText(d.card)}`
        : `${who} 使用了${cardText(d.card)}`
    }
    case 'respondCard':
      return `${playerName(num(d.player))} 打出了${cardText(d.card)}`
    case 'damage':
      return d.from === null
        ? `${playerName(num(d.to))} 受到 ${num(d.amount)} 点伤害`
        : `${playerName(num(d.from))} 对 ${playerName(num(d.to))} 造成 ${num(d.amount)} 点伤害`
    case 'recover':
      return `${playerName(num(d.to))} 回复 ${num(d.amount)} 点体力`
    case 'dying':
      return `${playerName(num(d.player))} 进入濒死,需要【桃】`
    case 'death':
      return `${playerName(num(d.player))} 阵亡`
    case 'discard': {
      const cards = Array.isArray(d.cards) ? d.cards.length : 0
      return `${playerName(num(d.player))} 弃置了 ${cards} 张牌`
    }
    case 'gameOver': {
      const winners = Array.isArray(d.winners) ? d.winners.map((w) => playerName(num(w))) : []
      return winners.length > 0 ? `对局结束,胜者:${winners.join('、')}` : '对局结束,平局'
    }
    default:
      return null
  }
}

/** 请求提示语 */
export function promptText(req: Request): string {
  const p: Prompt = req.prompt
  const source = typeof p.args.source === 'number' ? playerName(p.args.source) : ''
  const target = typeof p.args.target === 'number' ? playerName(p.args.target) : ''
  switch (p.key) {
    case 'play':
      return '出牌阶段:选一张牌使用,或结束出牌'
    case 'ask.jink':
      return `${source} 对你使用了【杀】,是否使用【闪】?`
    case 'ask.peach':
      return target === '你'
        ? '你处于濒死,是否使用【桃】?'
        : `${target} 处于濒死,是否对其使用【桃】?`
    case 'ask.nullification':
      return '是否使用【无懈可击】?'
    case 'discard':
      return req.kind === 'chooseCards' ? `弃牌阶段:请弃置 ${req.min} 张手牌` : '弃牌阶段:请弃牌'
    default:
      return '请做出选择'
  }
}
