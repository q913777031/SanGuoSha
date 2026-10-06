/**
 * cards/pattern.ts ─ 牌的匹配模式(纯数据)与匹配函数。引擎与客户端共用,不依赖状态。
 */
import type { CardName, CardPattern, CardSpec, Color, Suit } from '../core/types.js'

/** 只按牌名匹配的模式(其余维度不限制;区域缺省为手牌) */
export function byName(...names: CardName[]): CardPattern {
  return { names, suits: null, colors: null, numberRange: null, types: null, zones: null }
}

/** 花色 → 颜色:黑桃 / 梅花为黑,红桃 / 方块为红 */
export function colorOf(suit: Suit): Color {
  return suit === 'spade' || suit === 'club' ? 'black' : 'red'
}

/** 一张实体牌是否满足模式(不考虑 zones:区域过滤由 matchingCards 处理) */
export function matchPattern(spec: CardSpec, pattern: CardPattern): boolean {
  if (pattern.names !== null && !pattern.names.includes(spec.name)) return false
  if (pattern.suits !== null && !pattern.suits.includes(spec.suit)) return false
  if (pattern.colors !== null && !pattern.colors.includes(colorOf(spec.suit))) return false
  if (pattern.numberRange !== null) {
    const [lo, hi] = pattern.numberRange
    if (spec.number < lo || spec.number > hi) return false
  }
  if (pattern.types !== null && !pattern.types.includes(spec.type)) return false
  return true
}

/** 模式是否接受某牌名(八卦阵等"视为"类技能用:判断询问的是不是闪) */
export function patternAccepts(pattern: CardPattern, name: CardName): boolean {
  return pattern.names === null || pattern.names.includes(name)
}
