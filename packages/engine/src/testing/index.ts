/**
 * testing/index.ts ─ 对外导出的测试夹具('@sgs/engine/testing'):
 * ScriptedController(脚本应答)、answer(补全 kind / requestId 后 step)、buildState / buildGame(构造回合边界状态)、
 * recordingSkills(记录全部时机的锁定技)、createTestRegistry、runSync(同步跑完一局)。
 */
import { STANDARD_DECK } from '../cards/deck.standard.js'
import { standardM1 } from '../content/standardM1.js'
import { EngineError, Game } from '../core/engine.js'
import { createRegistryBuilder } from '../core/registry.js'
import { createInitialState } from '../core/state.js'
import type {
  CardId,
  ContentPackage,
  EngineOptions,
  EquipSlot,
  GameConfig,
  GameState,
  GeneralId,
  JsonValue,
  PlayerController,
  PlayerId,
  PlayerView,
  Registry,
  Request,
  RequestKind,
  Response,
  Role,
  SkillId,
  StepResult,
  Timing,
  TriggerSkill,
} from '../core/types.js'
import { EQUIP_SLOTS, TIMINGS } from '../core/types.js'
import { defaultResponse } from '../core/validate.js'
import { PLACEHOLDER_GENERAL_ID } from '../generals/placeholder.js'

/** 脚本步骤:固定应答,或按请求 / 视图现算的函数 */
export type ScriptedStep = Response | ((request: Request, view: PlayerView) => Response)

/** 按脚本依次应答的控制器;脚本耗尽后给默认应答;记录收到的全部请求 */
export class ScriptedController implements PlayerController {
  readonly requests: Request[] = []
  private readonly script: ScriptedStep[]

  constructor(script: ScriptedStep[] = []) {
    this.script = [...script]
  }

  /** 追加脚本步骤 */
  push(...steps: ScriptedStep[]): void {
    this.script.push(...steps)
  }

  respond(request: Request, view: PlayerView): Response {
    this.requests.push(request)
    const step = this.script.shift()
    if (step === undefined) return defaultResponse(request)
    return typeof step === 'function' ? step(request, view) : step
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** answer() 的应答正文:省略 kind 与 requestId(由当前 pending 请求补全) */
export type ResponseBody = DistributiveOmit<Response, 'kind' | 'requestId'>

/** 以当前 pending 请求的 kind / id 补全应答正文并 step */
export function answer(game: Game, body: ResponseBody): StepResult {
  const pending = game.pending
  if (pending === null) throw new EngineError('当前没有待应答的请求')
  const response = { ...body, kind: pending.kind, requestId: pending.id } as Response
  return game.step(response)
}

/** 断言当前 pending 请求的种类并返回它(类型收窄) */
export function expectRequest<K extends RequestKind>(
  game: Game,
  kind: K,
): Extract<Request, { kind: K }> {
  const pending = game.pending
  if (pending === null) throw new EngineError(`期望 ${kind} 请求,但对局没有待应答的请求`)
  if (pending.kind !== kind) throw new EngineError(`期望 ${kind} 请求,实际 ${pending.kind}`)
  return pending as Extract<Request, { kind: K }>
}

/** buildState 的玩家描述:未给出的牌留在牌堆 */
export interface PlayerSpec {
  general?: GeneralId
  hp?: number
  maxHp?: number
  alive?: boolean
  role?: Role
  hand?: CardId[]
  equips?: Partial<Record<EquipSlot, CardId>>
  judgeArea?: CardId[]
  skills?: SkillId[]
  flags?: Record<string, JsonValue>
  marks?: Record<string, number>
}

/** buildState 的状态描述 */
export interface StateSpec {
  players: PlayerSpec[]
  seed?: number
  mode?: string
  /** 放在牌堆顶的牌,第 0 项为顶 */
  drawPileTop?: CardId[]
  discardPile?: CardId[]
  lastTurnPlayer?: PlayerId | null
  turnCount?: number
  flags?: Record<string, JsonValue>
}

/** 由描述构造一个回合边界状态(phase = 'running'、栈为空):可直接 Game.fromState */
export function buildState(registry: Registry, spec: StateSpec): GameState {
  const config = configOf(spec, {})
  const state = createInitialState(config, registry)
  state.phase = 'running'
  state.lastTurnPlayer = spec.lastTurnPlayer ?? null
  state.turnCount = spec.turnCount ?? 0
  state.flags = spec.flags ?? {}
  const taken: boolean[] = []
  const take = (card: CardId, where: string): CardId => {
    const i = state.drawPile.indexOf(card)
    if (i < 0 || taken[card]) throw new EngineError(`buildState:牌 ${card} 重复出现(${where})`)
    taken[card] = true
    state.drawPile.splice(i, 1)
    return card
  }
  spec.players.forEach((ps, id) => {
    const p = state.players[id]
    if (p === undefined) throw new EngineError(`buildState:玩家 ${id} 不存在`)
    const general = registry.general(ps.general ?? PLACEHOLDER_GENERAL_ID)
    p.general = general.id
    p.kingdom = general.kingdom
    p.gender = general.gender
    p.maxHp = ps.maxHp ?? general.maxHp
    p.hp = ps.hp ?? p.maxHp
    p.alive = ps.alive ?? true
    p.role = ps.role ?? 'none'
    p.roleRevealed = true
    p.skills = ps.skills ?? [...general.skills]
    p.flags = ps.flags ?? {}
    p.marks = ps.marks ?? {}
    p.hand = (ps.hand ?? []).map((c) => take(c, `玩家 ${id} 手牌`))
    p.judgeArea = (ps.judgeArea ?? []).map((c) => take(c, `玩家 ${id} 判定区`))
    for (const slot of EQUIP_SLOTS) {
      const card = ps.equips?.[slot]
      if (card !== undefined) p.equips[slot] = take(card, `玩家 ${id} ${slot}`)
    }
  })
  state.discardPile = (spec.discardPile ?? []).map((c) => take(c, '弃牌堆'))
  const top = (spec.drawPileTop ?? []).map((c) => take(c, '牌堆顶'))
  for (let i = top.length - 1; i >= 0; i--) state.drawPile.push(top[i] as CardId)
  return state
}

function configOf(spec: StateSpec, options: Partial<EngineOptions>): GameConfig {
  return {
    seed: spec.seed ?? 1,
    mode: spec.mode ?? 'ffa',
    players: spec.players.map((p) => ({ general: p.general ?? null })),
    fixedDeckOrder: null,
    options,
  }
}

/** buildState + Game.fromState 的便捷封装(默认开启不变量断言与未消费 Flow 检测) */
export function buildGame(
  registry: Registry,
  spec: StateSpec,
  options: Partial<EngineOptions> = {},
): Game {
  const state = buildState(registry, spec)
  return Game.fromState(state, registry, configOf(spec, { ...TEST_OPTIONS, ...options }))
}

/** 测试默认引擎选项:断言不变量、检测未消费 Flow、非法应答抛错 */
export const TEST_OPTIONS: Partial<EngineOptions> = {
  assertInvariants: true,
  detectUnconsumedFlows: true,
  invalidResponsePolicy: 'throw',
}

/** 标准牌堆 + M1 内容包 + 额外测试内容包的注册表 */
export function createTestRegistry(...packages: ContentPackage[]): Registry {
  const builder = createRegistryBuilder()
    .setDeck([...STANDARD_DECK])
    .use(standardM1)
  for (const pkg of packages) builder.use(pkg)
  return builder.build()
}

/** 记录型技能集:每个时机一个锁定技(id = `${prefix}:${timing}`),发动时把 `${timing} ${kind}#${id}` 写入 records */
export function recordingSkills(
  prefix = 'record',
  timings: readonly Timing[] = TIMINGS,
): { skills: TriggerSkill[]; records: string[] } {
  const records: string[] = []
  const skills: TriggerSkill[] = timings.map((timing) =>
    recordingSkill(`${prefix}:${timing}`, timing, records),
  )
  return { skills, records }
}

/** 单个记录型锁定技:订阅一个时机,发动时把 `${timing} ${kind}#${id}` 追加到 records */
export function recordingSkill(id: SkillId, timing: Timing, records: string[]): TriggerSkill {
  return {
    id,
    name: id,
    description: `记录 ${timing} 时机`,
    locked: true,
    lord: false,
    type: 'trigger',
    timings: [timing],
    priority: 0,
    triggerWhenDead: true,
    canTrigger: () => true,
    *effect(_ctx, ev) {
      records.push(`${timing} ${ev.kind}#${ev.id}`)
      yield* []
    },
  }
}

/** 同步控制器:直接返回 Response 的函数,或 respond 为同步的 PlayerController */
export type SyncController =
  | ((request: Request, view: PlayerView) => Response)
  | { respond(request: Request, view: PlayerView): Response }

/** 同步跑完一局(控制器必须同步应答);返回最后的 StepResult */
export function runSync(
  game: Game,
  controllers: SyncController[],
  maxSteps = 1_000_000,
): StepResult {
  let r = game.start()
  let steps = 0
  while (r.type === 'request') {
    if (++steps > maxSteps) throw new EngineError(`runSync 超过 ${maxSteps} 步仍未结束`)
    const { player } = r.request
    const controller = controllers[player]
    if (controller === undefined) throw new EngineError(`玩家 ${player} 没有控制器`)
    const view = game.viewFor(player)
    const response =
      typeof controller === 'function'
        ? controller(r.request, view)
        : controller.respond(r.request, view)
    r = game.step(response)
  }
  return r
}
