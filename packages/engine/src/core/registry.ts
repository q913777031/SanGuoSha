/**
 * core/registry.ts ─ 注册表构建:牌表派生、内容包合并、校验、时机索引与 contentHash。
 * Registry 是实例而非全局单例:核心单测可注入假牌 / 假技能。
 */
import { EngineError } from './engine.js'
import { hashJson } from './hash.js'
import type {
  CardDef,
  CardName,
  CardSpec,
  CardType,
  ContentPackage,
  DeckEntry,
  GeneralDef,
  ModeDef,
  Registry,
  RegistryBuilder,
  SkillDef,
  SkillId,
  Timing,
  TriggerSkill,
} from './types.js'
import { TIMINGS } from './types.js'

function cardTypeOf(kind: DeckEntry['kind']): CardType {
  switch (kind) {
    case 'basic':
    case 'trick':
    case 'delayed_trick':
      return kind
    case 'weapon':
    case 'armor':
    case 'horse_offensive':
    case 'horse_defensive':
      return 'equip'
  }
}

/** 由牌堆数据派生静态牌表(下标即 CardId) */
export function deckToSpecs(entries: readonly DeckEntry[]): CardSpec[] {
  return entries.map((e, id) => {
    if (!Number.isInteger(e.rank) || e.rank < 1 || e.rank > 13) {
      throw new EngineError(`牌堆第 ${id} 条(${e.name})点数非法:${e.rank}`)
    }
    return { id, name: e.name, suit: e.suit, number: e.rank, type: cardTypeOf(e.kind) }
  })
}

/** 创建注册表构建器:setDeck 设牌堆、use 合并内容包、build 校验并冻结 */
export function createRegistryBuilder(): RegistryBuilder {
  let deck: DeckEntry[] | null = null
  const packages: ContentPackage[] = []
  const builder: RegistryBuilder = {
    setDeck(entries) {
      deck = [...entries]
      return builder
    },
    use(pkg) {
      packages.push(pkg)
      return builder
    },
    build() {
      if (deck === null) throw new EngineError('注册表缺少牌堆:请先 setDeck()')
      return buildRegistry(deck, packages)
    },
  }
  return builder
}

function buildRegistry(entries: DeckEntry[], packages: ContentPackage[]): Registry {
  const specs = deckToSpecs(entries)
  const cards: Record<CardName, CardDef> = {}
  const skills: Record<SkillId, SkillDef> = {}
  const generals: Record<string, GeneralDef> = {}
  const modes: Record<string, ModeDef> = {}
  const has = (record: Record<string, unknown>, id: string): boolean =>
    Object.prototype.hasOwnProperty.call(record, id)

  for (const pkg of packages) {
    for (const c of pkg.cards ?? []) {
      if (has(cards, c.name)) throw new EngineError(`牌 ${c.name} 重复注册(${pkg.name})`)
      cards[c.name] = c
    }
    for (const s of pkg.skills ?? []) {
      if (has(skills, s.id)) throw new EngineError(`技能 ${s.id} 重复注册(${pkg.name})`)
      skills[s.id] = s
    }
    for (const g of pkg.generals ?? []) {
      if (has(generals, g.id)) throw new EngineError(`武将 ${g.id} 重复注册(${pkg.name})`)
      generals[g.id] = g
    }
    for (const m of pkg.modes ?? []) {
      if (has(modes, m.id)) throw new EngineError(`模式 ${m.id} 重复注册(${pkg.name})`)
      modes[m.id] = m
    }
  }

  // 引用完整性与时机合法性
  for (const c of Object.values(cards)) {
    if ((c.type === 'equip') !== (c.equip !== null)) {
      throw new EngineError(`牌 ${c.name}:type 与 equip 字段不一致`)
    }
    for (const id of c.equip?.skills ?? []) {
      if (!has(skills, id)) throw new EngineError(`牌 ${c.name} 引用了未注册的技能 ${id}`)
    }
  }
  for (const g of Object.values(generals)) {
    if (!Number.isInteger(g.maxHp) || g.maxHp <= 0)
      throw new EngineError(`武将 ${g.id} 体力上限非法`)
    for (const id of g.skills) {
      if (!has(skills, id)) throw new EngineError(`武将 ${g.id} 引用了未注册的技能 ${id}`)
    }
  }
  const timingIndex: Record<string, TriggerSkill[]> = {}
  for (const t of TIMINGS) timingIndex[t] = []
  for (const s of Object.values(skills)) {
    if (s.type !== 'trigger') continue
    for (const t of s.timings) {
      const bucket = timingIndex[t]
      if (bucket === undefined) throw new EngineError(`技能 ${s.id} 声明了未知时机 ${String(t)}`)
      bucket.push(s)
    }
  }
  const priorityIndex: Record<string, number[]> = {}
  for (const t of TIMINGS) {
    const prios = [0]
    for (const s of timingIndex[t] ?? []) if (!prios.includes(s.priority)) prios.push(s.priority)
    prios.sort((a, b) => b - a)
    priorityIndex[t] = prios
  }

  const contentHash = hashJson({
    packages: packages.map((p) => ({ name: p.name, version: p.version })),
    cards: Object.keys(cards).sort(),
    skills: Object.keys(skills).sort(),
    generals: Object.keys(generals).sort(),
    modes: Object.keys(modes).sort(),
    deck: entries.map((e) => ({ name: e.name, kind: e.kind, suit: e.suit, rank: e.rank })),
  })

  const registry: Registry = {
    deck: Object.freeze(specs),
    contentHash,
    spec(card) {
      const s = specs[card]
      if (s === undefined) throw new EngineError(`牌 id ${card} 超出牌表范围`)
      return s
    },
    card(name) {
      return has(cards, name) ? (cards[name] ?? null) : null
    },
    skill(id) {
      const s = skills[id]
      if (s === undefined || !has(skills, id)) throw new EngineError(`技能 ${id} 未注册`)
      return s
    },
    general(id) {
      const g = generals[id]
      if (g === undefined || !has(generals, id)) throw new EngineError(`武将 ${id} 未注册`)
      return g
    },
    mode(id) {
      const m = modes[id]
      if (m === undefined || !has(modes, id)) throw new EngineError(`模式 ${id} 未注册`)
      return m
    },
    triggerSkillsAt(timing: Timing) {
      return timingIndex[timing] ?? []
    },
    triggerPriorities(timing: Timing) {
      return priorityIndex[timing] ?? [0]
    },
  }
  return Object.freeze(registry)
}
