/**
 * core/engine.ts ─ 引擎内核:错误类、runEvent / stage / gameOver 与 Game 类。
 *
 * Game 持有生成器协程 runGame(ctx),对外只有 start() / step(response):
 * 每喂入一条 Response 同步推进到下一个 Request 或对局结束(D1)。
 * 核心不认识 PlayerController;唯一的 async 代码在 core/runner.ts。
 */
import { handlers } from '../events/index.js'
import { runGame } from '../events/game.js'
import { guardFlow, createFlowGuard } from './flow.js'
import { cloneJson, hashJson } from './hash.js'
import { nextInt, nextRandom, shuffleInPlace } from './rng.js'
import { createInitialState } from './state.js'
import { trigger } from './trigger.js'
import type {
  AnyEventDraft,
  Ctx,
  EngineOptions,
  EventHandler,
  EventOf,
  Flow,
  GameApi,
  GameConfig,
  GameEvent,
  GameResult,
  GameState,
  LogDraft,
  LogEntry,
  PlayerId,
  PlayerView,
  Registry,
  Request,
  Response,
  Snapshot,
  StepResult,
  Timing,
  TimingEventMap,
} from './types.js'
import { STATE_SCHEMA_VERSION } from './types.js'
import { defaultResponse, validateResponse } from './validate.js'
import { viewFor } from './view.js'
import { assertCardInvariant } from './zones.js'

/** 引擎包版本:写入 Snapshot.engineVersion,恢复时做门禁 */
export const ENGINE_VERSION = '0.0.0'

/** 引擎错误基类:规则引擎内部断言失败、非法调用等 */
export class EngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineError'
  }
}

/**
 * 对局结束的控制流异常:gameOver() 先写 state.result / phase 再抛出,
 * 穿过所有 finally(只出栈、不断言、不 yield)到 runGame 被吞掉。
 */
export class GameOver extends Error {
  constructor() {
    super('对局结束')
    this.name = 'GameOver'
  }
}

/** 生成器已因非 GameOver 异常死亡后再调用 step() */
export class EngineBrokenError extends EngineError {
  constructor() {
    super('对局已因引擎异常损坏,请从最近的回合边界快照恢复')
    this.name = 'EngineBrokenError'
  }
}

/** 非法应答(options.invalidResponsePolicy === 'throw' 时抛出;生成器不前进,可重发同一 Request) */
export class InvalidResponseError extends EngineError {
  readonly reason: string
  constructor(reason: string) {
    super(`非法应答:${reason}`)
    this.name = 'InvalidResponseError'
    this.reason = reason
  }
}

/** 快照的 engineVersion / schemaVersion / contentHash 与当前不一致 */
export class IncompatibleSnapshotError extends EngineError {
  constructor(message: string) {
    super(message)
    this.name = 'IncompatibleSnapshotError'
  }
}

/** EngineOptions 缺省值 */
export const DEFAULT_OPTIONS: EngineOptions = {
  assertInvariants: false,
  detectUnconsumedFlows: false,
  maxTurns: 1000,
  maxStackDepth: 256,
  invalidResponsePolicy: 'throw',
  reopenNullification: true,
}

/**
 * 运行一个事件:分配 id、压栈、调用对应 handler、出栈;返回结算完毕的事件对象(含 cancelled 等结果字段)。
 * 嵌套结算 = 嵌套调用;state.stack 是生成器调用栈的数据镜像(D2)。
 * 出栈时(无异常在途)断言总牌数不变量并检查未消费 Flow。
 */
export function runEvent<D extends AnyEventDraft>(ctx: Ctx, draft: D): Flow<EventOf<D['kind']>> {
  return guardFlow(ctx, `runEvent:${draft.kind}`, () => runEventBody(ctx, draft))
}

function* runEventBody<D extends AnyEventDraft>(ctx: Ctx, draft: D): Flow<EventOf<D['kind']>> {
  const s = ctx.state
  if (s.stack.length >= ctx.options.maxStackDepth) {
    throw new EngineError(`结算栈深度超过上限 ${ctx.options.maxStackDepth}(${draft.kind})`)
  }
  const parent = s.stack[s.stack.length - 1]
  const ev = {
    ...draft,
    id: s.nextEventId++,
    parentId: parent === undefined ? null : parent.id,
    cancelled: false,
    tags: {},
  } as unknown as EventOf<D['kind']>
  s.stack.push(ev)
  let failed = false
  try {
    const handler = ctx.handlers[ev.kind] as EventHandler<GameEvent>
    yield* handler(ctx, ev)
  } catch (e) {
    failed = true
    throw e
  } finally {
    s.stack.pop()
    if (!failed) {
      if (ctx.options.assertInvariants) assertCardInvariant(ctx)
      if (ctx.options.detectUnconsumedFlows) ctx.guard.check(`事件 ${ev.kind}#${ev.id} 出栈`)
    }
  }
  return ev
}

/** 在时机点询问触发技;返回"事件是否仍有效",handler 写 if (!(yield* stage(...))) return */
export function stage<T extends Timing>(ctx: Ctx, timing: T, ev: TimingEventMap[T]): Flow<boolean> {
  return guardFlow(ctx, `stage:${timing}`, () => stageBody(ctx, timing, ev))
}

function* stageBody<T extends Timing>(ctx: Ctx, timing: T, ev: TimingEventMap[T]): Flow<boolean> {
  yield* trigger(ctx, timing, ev)
  return !ev.cancelled
}

/** 结束对局:写入 state.result 与 phase = 'over' 后抛出 GameOver(唯一的异常式控制流) */
export function gameOver(ctx: Ctx, result: GameResult): never {
  const s = ctx.state
  s.result = { winners: [...result.winners], reason: result.reason }
  s.phase = 'over'
  const top = s.stack[s.stack.length - 1]
  ctx.log({
    type: 'gameOver',
    data: { winners: [...result.winners], reason: result.reason },
    visibleTo: null,
    eventId: top === undefined ? null : top.id,
  })
  throw new GameOver()
}

/**
 * 对局实例:持有纯数据状态与生成器协程;start / step 同步推进;
 * fromState / restore / snapshot 实现回合边界快照与回放(D3 / D9)。
 */
export class Game implements GameApi {
  private readonly ctx: Ctx
  private readonly opts: EngineOptions
  private readonly cfg: GameConfig
  private readonly reg: Registry
  private gen: Flow<void> | null = null
  private pendingRequest: Request | null = null
  private broken = false
  private readonly logEntries: LogEntry[] = []
  private readonly allResponses: Response[] = []
  private responsesSinceBase: Response[] = []
  private base: GameState | null = null
  private logLengthAtBase = 0

  /**
   * 新建对局(phase = 'setup');initialState 仅供 fromState 使用:
   * 给定时跳过 createInitialState,直接以该状态(已克隆)继续。
   */
  constructor(config: GameConfig, registry: Registry, initialState?: GameState) {
    this.cfg = cloneJson(config)
    this.reg = registry
    this.opts = { ...DEFAULT_OPTIONS, ...this.cfg.options }
    const mode = registry.mode(this.cfg.mode)
    const n = this.cfg.players.length
    if (n < mode.playerCount[0] || n > mode.playerCount[1]) {
      throw new EngineError(
        `模式 ${mode.id} 需要 ${mode.playerCount[0]}~${mode.playerCount[1]} 名玩家,实际 ${n}`,
      )
    }
    const state = initialState ?? createInitialState(this.cfg, registry)
    if (state.players.length !== n) throw new EngineError('状态中的玩家数与配置不一致')
    this.ctx = {
      state,
      registry,
      config: this.cfg,
      options: this.opts,
      handlers,
      guard: createFlowGuard(this.opts.detectUnconsumedFlows),
      log: (entry: LogDraft) => this.appendLog(entry),
      random: () => {
        const [value, next] = nextRandom(state.rng)
        state.rng = next
        return value
      },
      randomInt: (limit: number) => {
        const [value, next] = nextInt(state.rng, limit)
        state.rng = next
        return value
      },
      shuffle: <T>(items: T[]) => {
        state.rng = shuffleInPlace(state.rng, items)
      },
      onTurnBoundary: () => this.takeBase(),
    }
  }

  /** 从回合边界状态重入:要求 stack 为空且对局未结束;状态会被克隆,调用方的对象不受影响 */
  static fromState(state: GameState, registry: Registry, config: GameConfig): Game {
    if (state.stack.length !== 0) throw new EngineError('只能从结算栈为空的回合边界状态重入')
    if (state.phase === 'over') throw new EngineError('对局已结束的状态不能重入')
    if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
      throw new IncompatibleSnapshotError(
        `状态结构版本 ${state.schemaVersion} 与当前 ${STATE_SCHEMA_VERSION} 不一致`,
      )
    }
    return new Game(config, registry, cloneJson(state))
  }

  /** 从快照恢复:版本门禁 → 以 base(或 config)建局 → 同步回放 responses → 停在最后一个未应答的 Request */
  static restore(snapshot: Snapshot, registry: Registry): Game {
    if (snapshot.schemaVersion !== STATE_SCHEMA_VERSION) {
      throw new IncompatibleSnapshotError(`快照 schemaVersion ${snapshot.schemaVersion} 不兼容`)
    }
    if (snapshot.engineVersion !== ENGINE_VERSION) {
      throw new IncompatibleSnapshotError(`快照 engineVersion ${snapshot.engineVersion} 不兼容`)
    }
    if (snapshot.contentHash !== registry.contentHash) {
      throw new IncompatibleSnapshotError('快照的 contentHash 与当前注册表不一致')
    }
    const game =
      snapshot.base === null
        ? new Game(snapshot.config, registry)
        : Game.fromState(snapshot.base, registry, snapshot.config)
    for (const entry of cloneJson(snapshot.log)) game.logEntries.push(entry)
    let r = game.start()
    for (const response of snapshot.responses) {
      if (r.type !== 'request') throw new EngineError('快照中的应答多于对局所需')
      r = game.step(response)
    }
    return game
  }

  get state(): GameState {
    return this.ctx.state
  }

  get pending(): Request | null {
    return this.pendingRequest
  }

  get log(): readonly LogEntry[] {
    return this.logEntries
  }

  get responses(): readonly Response[] {
    return this.allResponses
  }

  get options(): EngineOptions {
    return this.opts
  }

  get config(): GameConfig {
    return this.cfg
  }

  get registry(): Registry {
    return this.reg
  }

  /** 推进到第一个 Request(或直接结束);只能调用一次 */
  start(): StepResult {
    if (this.gen !== null) throw new EngineError('对局已经开始')
    this.gen = runGame(this.ctx)
    return this.advance(null, this.logEntries.length)
  }

  /** 校验并喂入一条应答;非法应答按 invalidResponsePolicy 抛错或替换为默认应答;只记录生效的应答 */
  step(response: Response): StepResult {
    if (this.broken) throw new EngineBrokenError()
    if (this.gen === null) throw new EngineError('对局尚未开始')
    if (this.pendingRequest === null) throw new EngineError('当前没有待应答的请求')
    const logStart = this.logEntries.length
    const verdict = validateResponse(this.ctx, this.pendingRequest, response)
    let effective = response
    if (!verdict.ok) {
      if (this.opts.invalidResponsePolicy === 'throw')
        throw new InvalidResponseError(verdict.reason)
      effective = defaultResponse(this.pendingRequest)
      this.appendLog({
        type: 'invalidResponse',
        data: { requestId: this.pendingRequest.id, reason: verdict.reason },
        visibleTo: null,
        eventId: null,
      })
    }
    this.allResponses.push(effective)
    this.responsesSinceBase.push(effective)
    return this.advance(effective, logStart)
  }

  /** 玩家视角的遮蔽视图(纯函数,只读状态) */
  viewFor(player: PlayerId): PlayerView {
    return viewFor(this.ctx, player, this.pendingRequest)
  }

  /** 规范化 JSON 后的 cyrb53 哈希;前置校验状态为纯数据 */
  stateHash(): string {
    return hashJson(this.ctx.state)
  }

  /** 回合边界快照 + 本回合应答(base 为 null 时退化为全量回放) */
  snapshot(): Snapshot {
    const full = this.base === null
    return {
      engineVersion: ENGINE_VERSION,
      schemaVersion: STATE_SCHEMA_VERSION,
      contentHash: this.reg.contentHash,
      config: cloneJson(this.cfg),
      base: this.base === null ? null : cloneJson(this.base),
      responses: cloneJson(full ? this.allResponses : this.responsesSinceBase),
      log: full ? [] : cloneJson(this.logEntries.slice(0, this.logLengthAtBase)),
    }
  }

  private takeBase(): void {
    this.base = cloneJson(this.ctx.state)
    this.responsesSinceBase = []
    this.logLengthAtBase = this.logEntries.length
  }

  private appendLog(entry: LogDraft): void {
    this.logEntries.push({ ...entry, seq: this.logEntries.length })
  }

  /** 推进生成器到下一个 Request 或结束;logStart = 本步开始时的日志长度,用于切出增量日志 */
  private advance(response: Response | null, logStart: number): StepResult {
    const gen = this.gen
    if (gen === null) throw new EngineError('对局尚未开始')
    let result: IteratorResult<Request, void>
    try {
      result = response === null ? gen.next() : gen.next(response)
      if (!result.done) {
        if (this.opts.assertInvariants) assertCardInvariant(this.ctx)
        if (this.opts.detectUnconsumedFlows) {
          this.ctx.guard.check(`请求 #${result.value.id} 等待点`)
        }
      }
    } catch (e) {
      this.broken = true
      this.pendingRequest = null
      throw e
    }
    const logs = this.logEntries.slice(logStart)
    if (result.done) {
      this.pendingRequest = null
      const final = this.ctx.state.result
      if (final === null || this.ctx.state.phase !== 'over') {
        this.broken = true
        throw new EngineError('生成器已结束但对局未写入结果')
      }
      return { type: 'over', result: final, logs }
    }
    this.pendingRequest = result.value
    return { type: 'request', request: result.value, logs }
  }
}
