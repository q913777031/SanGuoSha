/**
 * randomController.ts ─ 随机 AI:从 Request 的候选集中随机选一个合法项。
 * 用 (seed, player) 派生独立的 mulberry32 状态,与引擎 RNG 完全隔离(否则 AI 的随机会扰动牌堆)。
 * 只依赖 @sgs/engine 的公开 API 与 Request 里引擎算好的候选集,不复算规则。
 */
import type {
  ArrangeRequest,
  AskCardRequest,
  CardId,
  ChooseCardsRequest,
  ChoosePlayersRequest,
  PlayerController,
  PlayerId,
  PlayRequest,
  Request,
  Response,
  TargetSpec,
} from '@sgs/engine'
import { deriveSeed, nextInt, shuffleInPlace } from '@sgs/engine'

/** 随机 AI 的可调概率 */
export interface RandomControllerOptions {
  /** 出牌阶段每次决策直接结束的概率(有可用牌时);默认 0.25 */
  endProbability: number
  /** 被询问出牌(闪 / 桃 / 无懈)时响应的概率;默认 0.75 */
  respondProbability: number
  /** 可选触发技发动的概率;默认 0.5 */
  invokeProbability: number
}

const DEFAULTS: RandomControllerOptions = {
  endProbability: 0.25,
  respondProbability: 0.75,
  invokeProbability: 0.5,
}

class Rng {
  private state: number
  constructor(seed: number) {
    this.state = seed
  }
  /** [0, n) 的整数 */
  int(n: number): number {
    const [value, next] = nextInt(this.state, n)
    this.state = next
    return value
  }
  /** [0, 1) 的浮点数 */
  float(): number {
    return this.int(1_000_000) / 1_000_000
  }
  chance(p: number): boolean {
    return this.float() < p
  }
  pick<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[this.int(items.length)]
  }
  /** 从 items 中随机取 [min, max] 个不重复项(保持原顺序无关) */
  subset<T>(items: readonly T[], min: number, max: number): T[] {
    const copy = [...items]
    this.state = shuffleInPlace(this.state, copy)
    const hi = Math.min(max, copy.length)
    const lo = Math.min(min, hi)
    const count = lo + this.int(hi - lo + 1)
    return copy.slice(0, count)
  }
}

/** 随机 AI 控制器:respond 同步返回;createRandomController(seed, player) 派生独立随机源 */
export class RandomController implements PlayerController {
  private readonly rng: Rng
  private readonly opts: RandomControllerOptions

  constructor(seed: number, player: PlayerId, options: Partial<RandomControllerOptions> = {}) {
    this.rng = new Rng(deriveSeed(seed, player))
    this.opts = { ...DEFAULTS, ...options }
  }

  respond(request: Request): Response {
    switch (request.kind) {
      case 'play':
        return this.play(request)
      case 'askCard':
        return this.askCard(request)
      case 'chooseCards':
        return this.chooseCards(request)
      case 'choosePlayers':
        return this.choosePlayers(request)
      case 'choice':
        return {
          kind: 'choice',
          requestId: request.id,
          option: this.rng.pick(request.options) ?? '',
        }
      case 'invokeSkill':
        return {
          kind: 'invokeSkill',
          requestId: request.id,
          skill: this.rng.chance(this.opts.invokeProbability)
            ? (this.rng.pick(request.skills) ?? null)
            : null,
        }
      case 'arrange':
        return this.arrange(request)
    }
  }

  private targets(spec: TargetSpec): PlayerId[] {
    return this.rng.subset(spec.candidates, spec.min, spec.max)
  }

  private play(request: PlayRequest): Response {
    const options = request.usableCards.length + request.usableSkills.length
    if (options === 0 || this.rng.chance(this.opts.endProbability)) {
      return { kind: 'play', requestId: request.id, action: 'end' }
    }
    const index = this.rng.int(options)
    if (index < request.usableCards.length) {
      const usable = request.usableCards[index]
      if (usable === undefined) return { kind: 'play', requestId: request.id, action: 'end' }
      return {
        kind: 'play',
        requestId: request.id,
        action: 'useCard',
        card: usable.card,
        targets: this.targets(usable.targets),
      }
    }
    const skill = request.usableSkills[index - request.usableCards.length]
    if (skill === undefined) return { kind: 'play', requestId: request.id, action: 'end' }
    return {
      kind: 'play',
      requestId: request.id,
      action: 'useSkill',
      skill: skill.skill,
      as: skill.as,
      cards: this.rng.subset(skill.cards.candidates, skill.cards.min, skill.cards.max),
      targets: this.targets(skill.targets),
    }
  }

  private askCard(request: AskCardRequest): Response {
    const decline: Response = {
      kind: 'askCard',
      requestId: request.id,
      card: null,
      viewAs: null,
      targets: [],
    }
    if (!this.rng.chance(this.opts.respondProbability)) return decline
    const options = request.candidates.length + request.viewAsSkills.length
    if (options === 0) return decline
    const targets = request.targets === null ? [] : this.targets(request.targets)
    const index = this.rng.int(options)
    if (index < request.candidates.length) {
      const card = request.candidates[index]
      if (card === undefined) return decline
      return { kind: 'askCard', requestId: request.id, card, viewAs: null, targets }
    }
    const option = request.viewAsSkills[index - request.candidates.length]
    if (option === undefined) return decline
    return {
      kind: 'askCard',
      requestId: request.id,
      card: null,
      viewAs: {
        skill: option.skill,
        cards: this.rng.subset(option.cards.candidates, option.cards.min, option.cards.max),
      },
      targets,
    }
  }

  private chooseCards(request: ChooseCardsRequest): Response {
    const indices = request.candidates.map((c) => c.index)
    return {
      kind: 'chooseCards',
      requestId: request.id,
      indices: this.rng.subset(indices, request.min, request.max),
    }
  }

  private choosePlayers(request: ChoosePlayersRequest): Response {
    return {
      kind: 'choosePlayers',
      requestId: request.id,
      players: this.rng.subset(request.candidates, request.min, request.max),
    }
  }

  private arrange(request: ArrangeRequest): Response {
    const cards = [...request.cards]
    this.rng.subset([0], 0, 0)
    const placement: Record<string, CardId[]> = {}
    const shuffled = this.rng.subset(cards, cards.length, cards.length)
    let cursor = 0
    for (const slot of request.slots) {
      placement[slot.id] = shuffled.slice(cursor, cursor + slot.min)
      cursor += slot.min
    }
    const rest = shuffled.slice(cursor)
    for (const slot of request.slots) {
      const list = placement[slot.id] ?? []
      const room = slot.max - list.length
      const extra = Math.min(room, rest.length)
      const take = this.rng.int(extra + 1)
      list.push(...rest.splice(0, take))
      placement[slot.id] = list
    }
    for (const slot of request.slots) {
      const list = placement[slot.id] ?? []
      while (rest.length > 0 && list.length < slot.max) list.push(rest.shift() as CardId)
      placement[slot.id] = list
    }
    return { kind: 'arrange', requestId: request.id, placement }
  }
}

/** 创建随机 AI 控制器:(seed, player) 派生独立随机源 */
export function createRandomController(
  seed: number,
  player: PlayerId,
  options: Partial<RandomControllerOptions> = {},
): RandomController {
  return new RandomController(seed, player, options)
}
