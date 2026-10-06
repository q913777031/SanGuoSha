/**
 * core/validate.ts ─ 应答校验与默认应答(§5.2)。
 * 校验与候选集共用同一套函数(usableCards / legalTargets 已算进 Request),这里只复核应答落在候选内;
 * 应答来自不可信的远端,因此对结构也做防御性检查。
 */
import { faceOf } from './state.js'
import type {
  ArrangeRequest,
  AskCardRequest,
  CardId,
  ChooseCardsRequest,
  ChoosePlayersRequest,
  Ctx,
  PlayerId,
  PlayRequest,
  Request,
  Response,
  TargetSpec,
} from './types.js'

/** 校验结论:合法,或不合法及其原因(写入 invalidResponse 日志 / InvalidResponseError) */
export type Verdict = { ok: true } | { ok: false; reason: string }

const ok: Verdict = { ok: true }
const fail = (reason: string): Verdict => ({ ok: false, reason })

function isIntArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => Number.isInteger(v))
}

function hasDuplicate(items: number[]): boolean {
  const seen: Record<number, true> = {}
  for (const item of items) {
    if (seen[item]) return true
    seen[item] = true
  }
  return false
}

function checkSelection(
  label: string,
  chosen: unknown,
  candidates: readonly number[],
  min: number,
  max: number,
): Verdict {
  if (!isIntArray(chosen)) return fail(`${label} 必须是整数数组`)
  if (hasDuplicate(chosen)) return fail(`${label} 含重复项`)
  if (chosen.length < min || chosen.length > max) {
    return fail(`${label} 数量 ${chosen.length} 不在 [${min}, ${max}] 内`)
  }
  for (const item of chosen)
    if (!candidates.includes(item)) return fail(`${label} 含非候选项 ${item}`)
  return ok
}

function checkTargets(
  ctx: Ctx,
  request: PlayRequest | AskCardRequest,
  spec: TargetSpec,
  targets: unknown,
  card: CardId | null,
): Verdict {
  const v = checkSelection('目标', targets, spec.candidates, spec.min, spec.max)
  if (!v.ok) return v
  if (card === null) return ok
  const face = faceOf(ctx, card)
  const def = ctx.registry.card(face.name)
  if (def?.target.filter === undefined) return ok
  const selected: PlayerId[] = []
  for (const t of targets as PlayerId[]) {
    if (!def.target.filter(ctx, request.player, t, selected, face)) {
      return fail(`目标 ${t} 不满足该牌的目标条件`)
    }
    selected.push(t)
  }
  return ok
}

function validatePlay(ctx: Ctx, request: PlayRequest, response: Response): Verdict {
  if (response.kind !== 'play') return fail('应答种类不匹配')
  switch (response.action) {
    case 'end':
      return ok
    case 'useCard': {
      const usable = request.usableCards.find((u) => u.card === response.card)
      if (usable === undefined) return fail(`牌 ${response.card} 不在可使用列表内`)
      return checkTargets(ctx, request, usable.targets, response.targets, response.card)
    }
    case 'useSkill': {
      const usable = request.usableSkills.find(
        (u) => u.skill === response.skill && u.as === response.as,
      )
      if (usable === undefined) return fail(`技能 ${response.skill} 不在可发动列表内`)
      const cards = checkSelection(
        '选牌',
        response.cards,
        usable.cards.candidates,
        usable.cards.min,
        usable.cards.max,
      )
      if (!cards.ok) return cards
      return checkTargets(ctx, request, usable.targets, response.targets, null)
    }
    default:
      return fail('未知的出牌动作')
  }
}

function validateAskCard(ctx: Ctx, request: AskCardRequest, response: Response): Verdict {
  if (response.kind !== 'askCard') return fail('应答种类不匹配')
  if (response.card !== null && response.viewAs !== null) return fail('card 与 viewAs 只能二选一')
  if (response.card !== null) {
    if (!Number.isInteger(response.card) || !request.candidates.includes(response.card)) {
      return fail(`牌 ${response.card} 不在候选内`)
    }
  } else if (response.viewAs !== null) {
    const option = request.viewAsSkills.find((v) => v.skill === response.viewAs?.skill)
    if (option === undefined) return fail('转化技不在候选内')
    const v = checkSelection(
      '转化选牌',
      response.viewAs.cards,
      option.cards.candidates,
      option.cards.min,
      option.cards.max,
    )
    if (!v.ok) return v
  }
  if (!Array.isArray(response.targets)) return fail('targets 必须是数组')
  const responded = response.card !== null || response.viewAs !== null
  if (request.targets !== null && responded) {
    return checkTargets(ctx, request, request.targets, response.targets, response.card)
  }
  if (response.targets.length > 0) return fail('该询问不需要选择目标')
  return ok
}

function validateChooseCards(request: ChooseCardsRequest, response: Response): Verdict {
  if (response.kind !== 'chooseCards') return fail('应答种类不匹配')
  if (!isIntArray(response.indices)) return fail('indices 必须是整数数组')
  if (request.cancellable && response.indices.length === 0) return ok
  const indices = request.candidates.map((c) => c.index)
  return checkSelection('选牌', response.indices, indices, request.min, request.max)
}

function validateChoosePlayers(request: ChoosePlayersRequest, response: Response): Verdict {
  if (response.kind !== 'choosePlayers') return fail('应答种类不匹配')
  if (!isIntArray(response.players)) return fail('players 必须是整数数组')
  if (request.cancellable && response.players.length === 0) return ok
  return checkSelection('选人', response.players, request.candidates, request.min, request.max)
}

function validateArrange(request: ArrangeRequest, response: Response): Verdict {
  if (response.kind !== 'arrange') return fail('应答种类不匹配')
  const placement: unknown = response.placement
  if (typeof placement !== 'object' || placement === null || Array.isArray(placement)) {
    return fail('placement 必须是对象')
  }
  const record = placement as Record<string, unknown>
  const slotIds = request.slots.map((s) => s.id)
  for (const id of Object.keys(record)) if (!slotIds.includes(id)) return fail(`未知槽位 ${id}`)
  const all: CardId[] = []
  for (const slot of request.slots) {
    const list = record[slot.id] ?? []
    if (!isIntArray(list)) return fail(`槽位 ${slot.id} 必须是整数数组`)
    if (list.length < slot.min || list.length > slot.max) {
      return fail(`槽位 ${slot.id} 数量 ${list.length} 不在 [${slot.min}, ${slot.max}] 内`)
    }
    all.push(...list)
  }
  if (hasDuplicate(all)) return fail('同一张牌出现在多个槽位')
  if (all.length !== request.cards.length) return fail('牌数与请求不一致')
  for (const card of all) if (!request.cards.includes(card)) return fail(`牌 ${card} 不在请求内`)
  return ok
}

/** 校验一条应答是否对该请求合法:id / kind 匹配、选项落在候选内、数量在范围内、目标满足 filter */
export function validateResponse(ctx: Ctx, request: Request, response: Response): Verdict {
  if (typeof response !== 'object') return fail('应答必须是对象')
  if (response.requestId !== request.id) {
    return fail(`requestId ${response.requestId} 与当前请求 ${request.id} 不符`)
  }
  if (response.kind !== request.kind)
    return fail(`应答种类 ${response.kind} 与请求 ${request.kind} 不符`)
  switch (request.kind) {
    case 'play':
      return validatePlay(ctx, request, response)
    case 'askCard':
      return validateAskCard(ctx, request, response)
    case 'chooseCards':
      return validateChooseCards(request, response)
    case 'choosePlayers':
      return validateChoosePlayers(request, response)
    case 'choice':
      if (response.kind !== 'choice') return fail('应答种类不匹配')
      return request.options.includes(response.option) ? ok : fail(`选项 ${response.option} 不存在`)
    case 'invokeSkill':
      if (response.kind !== 'invokeSkill') return fail('应答种类不匹配')
      if (response.skill === null || request.skills.includes(response.skill)) return ok
      return fail(`技能 ${response.skill} 不在候选内`)
    case 'arrange':
      return validateArrange(request, response)
  }
}

/**
 * 确定性的默认应答:play → 结束;askCard → 不响应;chooseCards / choosePlayers → 按序取前 min 项;
 * choice → 第一项;invokeSkill → 不发动;arrange → 按顺序填满各槽的 min。
 * 远程超时 / 断线由服务端用它生成一条正常 Response 喂入。
 */
export function defaultResponse(request: Request): Response {
  switch (request.kind) {
    case 'play':
      return { kind: 'play', requestId: request.id, action: 'end' }
    case 'askCard':
      return { kind: 'askCard', requestId: request.id, card: null, viewAs: null, targets: [] }
    case 'chooseCards':
      return {
        kind: 'chooseCards',
        requestId: request.id,
        indices: request.candidates.slice(0, request.min).map((c) => c.index),
      }
    case 'choosePlayers':
      return {
        kind: 'choosePlayers',
        requestId: request.id,
        players: request.candidates.slice(0, request.min),
      }
    case 'choice':
      return { kind: 'choice', requestId: request.id, option: request.options[0] ?? '' }
    case 'invokeSkill':
      return { kind: 'invokeSkill', requestId: request.id, skill: null }
    case 'arrange': {
      const placement: Record<string, CardId[]> = {}
      let cursor = 0
      for (const slot of request.slots) {
        placement[slot.id] = request.cards.slice(cursor, cursor + slot.min)
        cursor += slot.min
      }
      const rest = request.cards.slice(cursor)
      for (const slot of request.slots) {
        const list = placement[slot.id] ?? []
        while (rest.length > 0 && list.length < slot.max) list.push(rest.shift() as CardId)
        placement[slot.id] = list
      }
      return { kind: 'arrange', requestId: request.id, placement }
    }
  }
}
