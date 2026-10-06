/**
 * generals/placeholder.ts ─ M1 无技能占位武将(4 血,魏,男);M3 补齐标准版 25 名武将后仍保留供测试使用。
 */
import type { GeneralDef } from '../core/types.js'

/** 占位武将 id */
export const PLACEHOLDER_GENERAL_ID = 'placeholder'

/** 占位武将定义:无技能、4 体力 */
export const placeholder: GeneralDef = {
  id: PLACEHOLDER_GENERAL_ID,
  name: '占位武将',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  skills: [],
}
