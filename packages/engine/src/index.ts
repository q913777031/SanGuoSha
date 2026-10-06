/**
 * @sgs/engine 公开入口。
 * 规则引擎只通过本文件导出的类型与函数对外暴露,内部模块不直接引用。
 */
import { STANDARD_DECK } from './cards/deck.standard.js'
import { standardM1 } from './content/standardM1.js'
import { createRegistryBuilder } from './core/registry.js'
import type { Registry } from './core/types.js'

export type * from './core/types.js'
export { PHASES, EQUIP_SLOTS, UNLIMITED, STATE_SCHEMA_VERSION, TIMINGS } from './core/types.js'

export {
  ENGINE_VERSION,
  DEFAULT_OPTIONS,
  Game,
  EngineError,
  GameOver,
  EngineBrokenError,
  InvalidResponseError,
  IncompatibleSnapshotError,
  runEvent,
  stage,
  gameOver,
} from './core/engine.js'
export { runGame } from './core/runner.js'
export { ask, askCard, createFlowGuard, guardFlow } from './core/flow.js'
export { trigger, skillsOf } from './core/trigger.js'
export { fold } from './core/modifiers.js'
export { createRegistryBuilder, deckToSpecs } from './core/registry.js'
export { viewFor, eventSummary, visibleTo } from './core/view.js'
export { validateResponse, defaultResponse } from './core/validate.js'
export type { Verdict } from './core/validate.js'
export { canonicalJson, cyrb53, hashJson, cloneJson } from './core/hash.js'
export { seedRng, deriveSeed, nextRandom, nextInt, shuffleInPlace } from './core/rng.js'
export {
  createInitialState,
  playerOf,
  playersFrom,
  nextAlive,
  anchor,
  orderTargets,
  eventById,
  seatDistance,
  weaponRange,
  attackRange,
  distance,
  inAttackRange,
  useLimit,
  usedInPlay,
  maxHandCards,
  faceOf,
  faceToJson,
  zoneToJson,
  handCount,
  handCandidates,
  defaultNullifiable,
  clearScopedFlags,
  legalTargets,
  autoTargets,
  resolveUseTargets,
  usableCards,
  usableSkills,
  matchingCards,
  viewAsOptions,
  viewAsFace,
} from './core/state.js'
export {
  zoneOf,
  allCardsOf,
  moveVisibility,
  moveCards,
  applyMoves,
  ensureDrawPile,
  peekDrawPile,
  drawFromPile,
  reorderDrawPile,
  initializeDrawPile,
  assertCardInvariant,
} from './core/zones.js'
export { handlers } from './events/index.js'
export { runGame as runGameFlow } from './events/game.js'
export { resolveNullification } from './events/cards.js'
export { retrial } from './events/judge.js'
export { matchPattern, byName, colorOf, patternAccepts } from './cards/pattern.js'
export { STANDARD_DECK } from './cards/deck.standard.js'
export { slash, jink, peach } from './cards/basic.js'
export { placeholder, PLACEHOLDER_GENERAL_ID } from './generals/placeholder.js'
export { ffa, INITIAL_HAND_SIZE } from './modes/ffa.js'
export { standardM1 } from './content/standardM1.js'

/** 标准牌堆 + M1 内容包构建的注册表(每次调用返回新实例) */
export function createStandardRegistry(): Registry {
  return createRegistryBuilder()
    .setDeck([...STANDARD_DECK])
    .use(standardM1)
    .build()
}
