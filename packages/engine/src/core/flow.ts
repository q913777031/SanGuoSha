/**
 * core/flow.ts ─ Flow(生成器协程)工具:ask / askCard 与"未消费生成器"运行时检测。
 *
 * 漏写 yield* 会让 Flow 静默不执行。工厂函数在创建生成器时向 FlowGuard 登记 token,
 * 生成器体第一行注销;事件出栈与每个 Request 等待点若仍有未注销 token 即抛 EngineError。
 */
import { EngineError, runEvent } from './engine.js'
import type {
  AnyRequestDraft,
  AskCardEvent,
  AskCardResult,
  Ctx,
  EventDraft,
  Flow,
  FlowGuard,
  Request,
  ResponseOf,
} from './types.js'

const NOOP_GUARD: FlowGuard = {
  create: () => 0,
  consume: () => undefined,
  check: () => undefined,
}

/** 创建未消费 Flow 检测器;enabled 为 false 时返回零开销的空实现 */
export function createFlowGuard(enabled: boolean): FlowGuard {
  if (!enabled) return NOOP_GUARD
  const pending: Record<number, string> = {}
  let count = 0
  let nextToken = 1
  return {
    create(label) {
      const token = nextToken++
      pending[token] = label
      count++
      return token
    },
    consume(token) {
      if (token in pending) {
        delete pending[token]
        count--
      }
    },
    check(where) {
      if (count > 0) {
        const labels = Object.values(pending).join(', ')
        throw new EngineError(`Flow created but never consumed(${where}):${labels}`)
      }
    },
  }
}

/**
 * 把一个生成器工厂包装成"创建即登记、开始执行即注销"的 Flow。
 * detectUnconsumedFlows 关闭时直接返回 body(),无额外开销。
 */
export function guardFlow<T>(ctx: Ctx, label: string, body: () => Flow<T>): Flow<T> {
  if (!ctx.options.detectUnconsumedFlows) return body()
  const token = ctx.guard.create(label)
  return consumeThenRun(ctx, token, body)
}

function* consumeThenRun<T>(ctx: Ctx, token: number, body: () => Flow<T>): Flow<T> {
  ctx.guard.consume(token)
  return yield* body()
}

/** 向玩家发出一个请求(分配 id)并等待应答;应答已由 Game.step 校验,这里只做种类 / id 的防御性复核 */
export function ask<D extends AnyRequestDraft>(ctx: Ctx, draft: D): Flow<ResponseOf<D['kind']>> {
  return guardFlow(ctx, `ask:${draft.kind}`, () => askBody(ctx, draft))
}

function* askBody<D extends AnyRequestDraft>(ctx: Ctx, draft: D): Flow<ResponseOf<D['kind']>> {
  const request: Request = { ...draft, id: ctx.state.nextRequestId++ }
  const response = yield request
  if (response.kind !== request.kind || response.requestId !== request.id) {
    throw new EngineError(
      `应答与请求不匹配:期望 ${request.kind}#${request.id},收到 ${response.kind}#${response.requestId}`,
    )
  }
  return response as ResponseOf<D['kind']>
}

/** 询问玩家使用 / 打出一张符合 pattern 的牌(作为 AskCard 事件运行),返回结果快照 */
export function askCard(
  ctx: Ctx,
  draft: Omit<EventDraft<AskCardEvent>, 'kind' | 'result'>,
): Flow<AskCardResult> {
  return guardFlow(ctx, 'askCard', () => askCardBody(ctx, draft))
}

function* askCardBody(
  ctx: Ctx,
  draft: Omit<EventDraft<AskCardEvent>, 'kind' | 'result'>,
): Flow<AskCardResult> {
  const ev = yield* runEvent(ctx, {
    kind: 'AskCard',
    ...draft,
    result: { responded: false, card: null },
  })
  return ev.result
}
