/**
 * 对局驱动与界面状态(zustand)。
 * 引擎是同步的 Game.step;本模块负责:AI 座位按固定节奏自动应答、真人座位停下等待界面操作,
 * 并把引擎日志渲染成中文。界面只通过本 store 读写,不直接接触 Game。
 */
import type {
  CardId,
  GameConfig,
  GameResult,
  PlayerId,
  PlayerView,
  Request,
  Response,
  StepResult,
} from '@sgs/engine'
import { createStandardRegistry, defaultResponse, Game, InvalidResponseError } from '@sgs/engine'
import { createRandomController, type RandomController } from '@sgs/ai'
import { create } from 'zustand'

import { formatLog, HUMAN } from './labels.js'

/** AI 每一步之间的间隔(毫秒),让玩家看得清 */
const AI_DELAY_MS = 420
const MAX_LOG_LINES = 60

/** 桌面上最近一次出牌 */
export interface TablePlay {
  key: number
  player: PlayerId
  card: CardId | null
  name: string
  verb: 'use' | 'respond'
}

export interface GameUiState {
  seed: number
  playerCount: number
  view: PlayerView | null
  /** 只在轮到真人应答时非 null */
  request: Request | null
  result: GameResult | null
  logs: string[]
  table: TablePlay[]
  /** 已选的牌:play / askCard 为 CardId,chooseCards 为候选 index */
  selected: number[]
  targets: PlayerId[]
  error: string | null
  newGame(seed?: number): void
  toggleCard(card: CardId): void
  toggleTarget(player: PlayerId): void
  confirm(): void
  cancel(): void
}

let game: Game | null = null
let ais: RandomController[] = []
let generation = 0
let tableKey = 0

function makeConfig(seed: number, playerCount: number): GameConfig {
  return {
    seed,
    mode: 'ffa',
    players: Array.from({ length: playerCount }, () => ({ general: null })),
    fixedDeckOrder: null,
    options: { invalidResponsePolicy: 'throw' },
  }
}

export const useGame = create<GameUiState>((set, get) => {
  /** 处理一次推进结果:写日志 → 结束 / 等真人 / 排期 AI */
  function absorb(r: StepResult, gen: number): void {
    if (gen !== generation || !game) return
    const lines: string[] = []
    const plays: TablePlay[] = []
    for (const e of r.logs) {
      if (e.visibleTo !== null && !e.visibleTo.includes(HUMAN)) continue
      const line = formatLog(e)
      if (line) lines.push(line)
      if (e.type === 'useCard' || e.type === 'respondCard') {
        const d = e.data as {
          source?: number
          player?: number
          card?: { name?: string; subcards?: number[] }
        }
        plays.push({
          key: ++tableKey,
          player: (e.type === 'useCard' ? d.source : d.player) ?? -1,
          card: d.card?.subcards?.[0] ?? null,
          name: d.card?.name ?? '',
          verb: e.type === 'useCard' ? 'use' : 'respond',
        })
      }
    }
    const s = get()
    const logs = [...s.logs, ...lines].slice(-MAX_LOG_LINES)
    const table = plays.length > 0 ? [...s.table, ...plays].slice(-4) : s.table
    const view = game.viewFor(HUMAN)

    if (r.type === 'over') {
      set({ logs, table, view, request: null, result: r.result, selected: [], targets: [] })
      return
    }
    const req = r.request
    if (req.player === HUMAN) {
      set({ logs, table, view, request: req, selected: [], targets: [], error: null })
      autoSelect(req)
      return
    }
    set({ logs, table, view, request: null })
    window.setTimeout(() => {
      if (gen !== generation || !game) return
      const ai = ais[req.player]
      const resp = ai ? ai.respond(req) : defaultResponse(req)
      absorb(game.step(resp), gen)
    }, AI_DELAY_MS)
  }

  /** 只有一个合法目标时自动选中,减少点击 */
  function autoSelect(req: Request): void {
    if (req.kind !== 'chooseCards') return
    if (req.min === req.max && req.candidates.length === req.min) {
      set({ selected: req.candidates.map((c) => c.index) })
    }
  }

  function submit(resp: Response): void {
    if (!game) return
    const gen = generation
    try {
      const r = game.step(resp)
      set({ request: null, selected: [], targets: [], error: null })
      absorb(r, gen)
    } catch (e) {
      if (e instanceof InvalidResponseError) {
        set({ error: '这一步不合法,请重新选择' })
        return
      }
      throw e
    }
  }

  return {
    seed: 1,
    playerCount: 4,
    view: null,
    request: null,
    result: null,
    logs: [],
    table: [],
    selected: [],
    targets: [],
    error: null,

    newGame(seed) {
      const s = seed ?? Date.now() % 1_000_000_007
      const n = get().playerCount
      generation++
      game = new Game(makeConfig(s, n), createStandardRegistry())
      ais = Array.from({ length: n }, (_, p) => createRandomController(s, p))
      set({
        seed: s,
        view: null,
        request: null,
        result: null,
        logs: [],
        table: [],
        selected: [],
        targets: [],
        error: null,
      })
      absorb(game.start(), generation)
    },

    toggleCard(card) {
      const { request: req, selected } = get()
      if (!req) return
      if (req.kind === 'play') {
        const usable = req.usableCards.find((u) => u.card === card)
        if (!usable) return
        if (selected[0] === card) {
          set({ selected: [], targets: [] })
          return
        }
        const t = usable.targets
        const auto =
          t.min === 1 && t.max === 1 && t.candidates.length === 1 ? [...t.candidates] : []
        set({ selected: [card], targets: auto, error: null })
      } else if (req.kind === 'askCard') {
        if (!req.candidates.includes(card)) return
        set({ selected: selected[0] === card ? [] : [card], error: null })
      } else if (req.kind === 'chooseCards') {
        const cand = req.candidates.find((c) => c.card === card)
        if (!cand) return
        if (selected.includes(cand.index)) {
          set({ selected: selected.filter((i) => i !== cand.index) })
        } else if (selected.length < req.max) {
          set({ selected: [...selected, cand.index] })
        } else if (req.max === 1) {
          set({ selected: [cand.index] })
        }
      }
    },

    toggleTarget(player) {
      const { request: req, selected, targets } = get()
      if (!req || req.kind !== 'play' || selected.length === 0) return
      const usable = req.usableCards.find((u) => u.card === selected[0])
      if (!usable || !usable.targets.candidates.includes(player)) return
      if (targets.includes(player)) set({ targets: targets.filter((t) => t !== player) })
      else if (usable.targets.max === 1) set({ targets: [player] })
      else if (targets.length < usable.targets.max) set({ targets: [...targets, player] })
    },

    confirm() {
      const { request: req, selected, targets } = get()
      if (!req) return
      switch (req.kind) {
        case 'play': {
          const card = selected[0]
          if (card === undefined) return
          submit({ kind: 'play', requestId: req.id, action: 'useCard', card, targets })
          return
        }
        case 'askCard': {
          const card = selected[0]
          if (card === undefined) return
          submit({ kind: 'askCard', requestId: req.id, card, viewAs: null, targets: [] })
          return
        }
        case 'chooseCards':
          submit({ kind: 'chooseCards', requestId: req.id, indices: selected })
          return
        case 'choosePlayers':
        case 'choice':
        case 'invokeSkill':
        case 'arrange':
          submit(defaultResponse(req))
      }
    },

    cancel() {
      const req = get().request
      if (!req) return
      switch (req.kind) {
        case 'play':
          submit({ kind: 'play', requestId: req.id, action: 'end' })
          return
        case 'askCard':
          submit({ kind: 'askCard', requestId: req.id, card: null, viewAs: null, targets: [] })
          return
        case 'chooseCards':
        case 'choosePlayers':
        case 'choice':
        case 'invokeSkill':
        case 'arrange':
          if ('cancellable' in req && !req.cancellable) return
          submit(defaultResponse(req))
      }
    },
  }
})

/** 当前选择能否确认 */
export function canConfirm(s: GameUiState): boolean {
  const req = s.request
  if (!req) return false
  switch (req.kind) {
    case 'play': {
      const usable = req.usableCards.find((u) => u.card === s.selected[0])
      if (!usable) return false
      return s.targets.length >= usable.targets.min && s.targets.length <= usable.targets.max
    }
    case 'askCard':
      return s.selected.length === 1
    case 'chooseCards':
      return s.selected.length >= req.min && s.selected.length <= req.max
    case 'choosePlayers':
    case 'choice':
    case 'invokeSkill':
    case 'arrange':
      return true
  }
}

/** 真人手牌中当前可点选的牌 */
export function selectableCards(req: Request | null): Set<CardId> {
  if (!req) return new Set()
  switch (req.kind) {
    case 'play':
      return new Set(req.usableCards.map((u) => u.card))
    case 'askCard':
      return new Set(req.candidates)
    case 'chooseCards':
      return new Set(req.candidates.flatMap((c) => (c.card === null ? [] : [c.card])))
    case 'choosePlayers':
    case 'choice':
    case 'invokeSkill':
    case 'arrange':
      return new Set()
  }
}

/** 当前可被点选为目标的座位 */
export function targetableSeats(s: GameUiState): Set<PlayerId> {
  const req = s.request
  if (!req || req.kind !== 'play') return new Set()
  const usable = req.usableCards.find((u) => u.card === s.selected[0])
  return new Set(usable ? usable.targets.candidates : [])
}
