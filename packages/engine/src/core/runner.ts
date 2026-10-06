/**
 * core/runner.ts ─ 引擎包内唯一的 async 代码:把 PlayerController 的应答喂给 Game。
 * 核心模块不 import 本文件。
 */
import type { Game } from './engine.js'
import { EngineError } from './engine.js'
import type { GameResult, PlayerController } from './types.js'
import { visibleTo } from './view.js'

export type { PlayerController } from './types.js'

/** 用控制器把一局打完:每步把增量日志 notify 给各控制器,向待应答者索取 Response;返回对局结果 */
export async function runGame(game: Game, controllers: PlayerController[]): Promise<GameResult> {
  let r = game.start()
  for (;;) {
    controllers.forEach((c, i) => {
      if (c.notify) c.notify(game.viewFor(i), visibleTo(r.logs, i))
    })
    if (r.type === 'over') return r.result
    const { player } = r.request
    const controller = controllers[player]
    if (controller === undefined) throw new EngineError(`玩家 ${player} 没有控制器`)
    r = game.step(await controller.respond(r.request, game.viewFor(player)))
  }
}
