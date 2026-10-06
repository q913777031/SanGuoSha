/**
 * content/standardM1.ts ─ M1 内容包:杀 / 闪 / 桃、占位武将、无身份混战模式。
 */
import { jink, peach, slash } from '../cards/basic.js'
import type { ContentPackage } from '../core/types.js'
import { placeholder } from '../generals/placeholder.js'
import { ffa } from '../modes/ffa.js'

/** M1 内容包(版本号参与 contentHash) */
export const standardM1: ContentPackage = {
  name: 'standard-m1',
  version: '0.1.0',
  cards: [slash, jink, peach],
  generals: [placeholder],
  modes: [ffa],
}
