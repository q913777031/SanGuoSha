/**
 * 无头模拟器:pnpm sim --games N --seed S --players P(默认 100 / 1 / 5)。
 * 每局 new Game + runGame(随机 AI),开启不变量断言与未消费 Flow 检测;
 * 统计异常数(打印首个异常栈)、平均 / 最大回合数、胜者分布、每局 stateHash,
 * 并对每局用同一 seed 重跑一次比对 hash。退出码非 0 表示有异常或 hash 不一致。
 */
import { createRandomController } from '@sgs/ai'
import type { GameConfig, GameResult } from '@sgs/engine'
import { Game, createStandardRegistry, runGame } from '@sgs/engine'

interface Args {
  games: number
  seed: number
  players: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { games: 100, seed: 1, players: 5 }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    const raw = argv[i + 1]
    // pnpm 会把分隔符 "--" 原样转发进来,跳过它
    if (key === undefined || key === '--' || !key.startsWith('--')) continue
    const value = Number(raw)
    if (raw === undefined || !Number.isFinite(value)) throw new Error(`参数 ${key} 需要一个数值`)
    if (key === '--games') args.games = value
    else if (key === '--seed') args.seed = value
    else if (key === '--players') args.players = value
    else throw new Error(`未知参数 ${key}`)
    i++
  }
  return args
}

interface Outcome {
  result: GameResult
  turns: number
  hash: string
}

async function playOne(seed: number, players: number): Promise<Outcome> {
  const registry = createStandardRegistry()
  const config: GameConfig = {
    seed,
    mode: 'ffa',
    players: Array.from({ length: players }, () => ({ general: null })),
    fixedDeckOrder: null,
    options: {
      assertInvariants: true,
      detectUnconsumedFlows: true,
      invalidResponsePolicy: 'throw',
    },
  }
  const game = new Game(config, registry)
  const controllers = Array.from({ length: players }, (_, p) => createRandomController(seed, p))
  const result = await runGame(game, controllers)
  return { result, turns: game.state.turnCount, hash: game.stateHash() }
}

function describeError(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const out = (line: string): boolean => process.stdout.write(`${line}\n`)
  out(`sim: games=${args.games} seed=${args.seed} players=${args.players}`)
  let errors = 0
  let mismatches = 0
  let totalTurns = 0
  let maxTurns = 0
  let finished = 0
  const winners: Record<string, number> = {}
  const reasons: Record<string, number> = {}
  const started = performance.now()
  for (let i = 0; i < args.games; i++) {
    const seed = args.seed + i
    let first: Outcome
    try {
      first = await playOne(seed, args.players)
    } catch (e) {
      errors++
      if (errors === 1) out(`首个异常(seed=${seed}):\n${describeError(e)}`)
      else out(`game #${i} seed=${seed} 异常:${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    let second: Outcome
    try {
      second = await playOne(seed, args.players)
    } catch (e) {
      errors++
      out(`game #${i} seed=${seed} 重跑异常:${describeError(e)}`)
      continue
    }
    const consistent = first.hash === second.hash
    if (!consistent) {
      mismatches++
      out(`game #${i} seed=${seed} 同种子重跑 hash 不一致:${first.hash} ≠ ${second.hash}`)
    }
    finished++
    totalTurns += first.turns
    maxTurns = Math.max(maxTurns, first.turns)
    const winnerKey = first.result.winners.length === 0 ? 'draw' : first.result.winners.join('+')
    winners[winnerKey] = (winners[winnerKey] ?? 0) + 1
    reasons[first.result.reason] = (reasons[first.result.reason] ?? 0) + 1
    out(
      `game #${i} seed=${seed} turns=${first.turns} winner=${winnerKey} reason=${first.result.reason} hash=${first.hash}`,
    )
  }
  const elapsed = ((performance.now() - started) / 1000).toFixed(2)
  out('')
  out(`完成 ${finished}/${args.games} 局,用时 ${elapsed}s`)
  out(`异常 ${errors} 局;同种子 hash 不一致 ${mismatches} 局`)
  if (finished > 0) {
    out(`平均回合 ${(totalTurns / finished).toFixed(2)},最大回合 ${maxTurns}`)
  }
  out(
    `胜者分布:${Object.keys(winners)
      .sort()
      .map((k) => `${k}=${winners[k] ?? 0}`)
      .join(' ')}`,
  )
  out(
    `结束原因:${Object.keys(reasons)
      .sort()
      .map((k) => `${k}=${reasons[k] ?? 0}`)
      .join(' ')}`,
  )
  return errors > 0 || mismatches > 0 ? 1 : 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    process.stderr.write(`${describeError(e)}\n`)
    process.exitCode = 1
  },
)
