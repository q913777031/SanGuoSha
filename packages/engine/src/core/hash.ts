/**
 * core/hash.ts ─ 规范化 JSON 与 cyrb53 哈希。
 * stateHash / contentHash 都经由这里:键排序、数组保序,拒绝 undefined / NaN / Infinity / 函数 / 非纯对象。
 */
import { EngineError } from './engine.js'

/**
 * 把纯数据序列化为规范 JSON:对象键按 UTF-16 码元升序,数组保序。
 * 遇到不可序列化的值(undefined、NaN、Infinity、函数、类实例)抛 EngineError,用于锁住"状态是纯数据"纪律。
 */
export function canonicalJson(value: unknown, path = '$'): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new EngineError(`状态含非有限数值(${path}):${value}`)
    return JSON.stringify(value)
  }
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return `[${value.map((item, i) => canonicalJson(item, `${path}[${i}]`)).join(',')}]`
    }
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new EngineError(`状态含非纯对象(${path})`)
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const parts: string[] = []
    for (const key of keys) {
      const item = record[key]
      if (item === undefined) throw new EngineError(`状态含 undefined(${path}.${key})`)
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item, `${path}.${key}`)}`)
    }
    return `{${parts.join(',')}}`
  }
  throw new EngineError(`状态含不可序列化的值(${path}):${typeof value}`)
}

/** cyrb53 字符串哈希(53 位),返回 14 位十六进制字符串;确定、跨平台一致 */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const high = 2097151 & h2
  const low = h1 >>> 0
  return high.toString(16).padStart(6, '0') + low.toString(16).padStart(8, '0')
}

/** 对任意纯数据做规范化后哈希;GameState 与 Registry 内容清单共用 */
export function hashJson(value: unknown): string {
  return cyrb53(canonicalJson(value))
}

/** JSON 往返深克隆:只用于已满足纯数据纪律的值(GameState / GameConfig / 日志) */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
