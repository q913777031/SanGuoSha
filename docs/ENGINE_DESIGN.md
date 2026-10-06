# 三国杀规则引擎 · M1 核心架构设计(定稿)

> 包:`packages/engine`。纯 TypeScript(strict,沿用 `tsconfig.base.json` 的 `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`),零 UI、零 IO,Node 无头可运行,Vitest 测试。
> 底本:《生成器协程驱动 · 事件/时机/结算栈 · Request/Response 唯一出口》方案,按三份评审修订;嫁接了显式状态机方案的"回合边界可序列化快照 / 候选集由引擎算好 / 非法应答落默认值并只记录生效应答"与 async 方案的"打出 vs 使用分离 / 改判原子动作 / Prompt 可本地化 / 盲位选牌"。
> 配套类型骨架:`docs/engine-core-types.draft.ts`(已用仓库 strict 配置 tsc 通过;实现阶段原样作为 `packages/engine/src/core/types.ts` 起点)。
> 参考(只参考设计,未拷贝代码):FreeKill 的 GameEvent / TriggerSkill / `Room:askFor*`;QSanguosha 的 RoomThread 触发循环。
> 卡名、技能 id 以 `docs/data/standard-deck.md`、`docs/data/standard-generals.md` 为准(`slash` / `jink` / `peach` / `nullification` …)。

---

## 0. 一页总览

```
                 ┌───────────────────── packages/engine(核心:同步、无 IO、无 Promise)──────────────────────┐
                 │  Game                                                                                      │
  Response ───►  │   step(resp) ─► validateResponse ─► gen.next(resp) ─► 生成器继续跑结算 ……                  │ ───► Request
                 │                                                                                            │
                 │   runGame()* ─ Turn* ─ Phase* ─ CardUse* ─ CardEffect* ─ Damage* ─ Dying* ─ Death*          │
                 │      每个事件:runEvent() 压栈 → handler → 各时机点 stage()/trigger() → 出栈 + 总牌数断言   │
                 │   registry: CardDef / SkillDef(trigger|modifier|active|viewAs) / GeneralDef / ModeDef       │
                 │   GameState = 纯数据(事件间只有 id 引用);日志在 Game 上,不在状态里                          │
                 └────────────────────────────────────────────────────────────────────────────────────────────┘
                                   ▲ 唯一出口:Request / Response(纯数据)
  GameRunner(async,约 25 行) ── controller.respond(request, viewFor(player)) ── 真人 UI / AI / 远程
```

核心决定(编号在全文引用):

| #   | 决定                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **驱动模型:生成器协程**。`Flow<T> = Generator<Request, T, Response>`;`Game.step(response)` 同步推进一步;核心不认识 `PlayerController`。                          |
| D2  | **一切行为是事件**:`runEvent(ctx, draft)` 压入 `state.stack`,handler 在固定时机点 `stage()` 询问触发技。嵌套结算 = 嵌套的生成器调用,`state.stack` 是其数据镜像。 |
| D3  | **状态是真正可恢复的纯数据**:事件之间只用 `EventId` 引用;`AskCard.result`、日志都是快照;`Game.fromState()` 可从任意回合边界重入。                                |
| D4  | **询问是事件**:`AskCard` 有 `AskCard.before/after` 时机,八卦阵 / 护驾 / 铁骑 / 急救类"替代或禁止响应"技能纯靠注册。                                              |
| D5  | **单目标单效果**:`CardEffect` 是无懈、仁王盾"无效"、多目标逐个结算三件事共用的作用单位;零目标牌恰产生一个 `target = null` 的 `CardEffect`。                      |
| D6  | **打出 ≠ 使用**:`CardRespond`(打出)是独立事件,不产生 `CardEffect`。                                                                                              |
| D7  | **修正技是纯函数折叠**:`fold(ctx, hook, base, ...args)` 按座位序折叠所有玩家(含装备)的修正钩子;钩子表可由内容包用 `declare module` 扩展。                        |
| D8  | **触发技调度**:优先级桶(降序)→ 从当前回合玩家起座位序 → 同玩家锁定技先、可选技由玩家选 → 每发动一次重扫 → `times()` 控制同事件多次触发。                         |
| D9  | **存档 = 回合边界状态快照 + 本回合应答序列;回放 = 配置 + 全部应答序列**。两者同一 `Snapshot` 类型,恢复都是同步 `step()`。                                        |
| D10 | **确定性是结构保证**:RNG 状态在 `GameState`;输入只有 Response;遍历一律座位序 / 数据声明序;`Infinity`、`Map/Set`、`Date`、`Math.random` 不得进入引擎。            |

---

## 1. 驱动模型:生成器协程 + 同步 `step(Response)`

### 1.1 三方案对比

| 维度                | async/await(引擎 await controller)                                         | **generator(引擎 yield Request)**                                                                           | 显式状态机 / 事件队列(每 feed 一个 Response 推进一步)                                                          |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 可读性 / 内容代码量 | 最好:嵌套结算就是函数递归                                                  | 与 async 几乎相同,`await` → `yield*`,签名 `Flow<T>`                                                         | 最差:每个"问一下玩家再继续"的点都要拆成带续体数据的帧;濒死求桃、无懈递归、多目标循环都要手写游标与 resume 逻辑 |
| 中途存档            | JS 调用栈不可序列化 ⇒ 只能回放恢复                                         | 生成器帧不可序列化 ⇒ **回合边界快照 + 本回合应答回放**(§9.3);回放同步、毫秒级                               | 续体本身是数据,任意点 `JSON.stringify` 即存档——它唯一的明显优势                                                |
| 联机服务端权威      | 每局一条挂起的 Promise,超时 / 断线处理与引擎耦合                           | 服务端持有 `Game`,收到一条 Response 调一次 `step()`,返回下一个 Request;超时 / 断线 / 重连完全在引擎之外决定 | 同 generator                                                                                                   |
| 测试可控性          | 测试必须 async;控制器不应答就挂死;微任务顺序偶发影响                       | **完全同步**:`let r = g.start(); r = g.step(resp)` 一行一步,任意等待点 `expect(state)`,无挂死               | 同步,但断言要理解帧结构                                                                                        |
| 确定性              | 只有一个 await 点在跑,实际确定,但靠纪律                                    | 结构性:引擎内没有任何异步源,输入只有 Response 序列                                                          | 同 generator                                                                                                   |
| 新内容(M2 / M3)成本 | 低                                                                         | 低(写 `function*`,用 `yield*`)                                                                              | 高(每个带询问的技能是一个小状态机;标准 25 将估计 2000–3000 行,其中 ~40% 是游标样板)                            |
| 先例                | FreeKill 用 Lua coroutine、QSanguosha 用线程阻塞——本质都是"挂起式"直写结算 | 同左,且把"每 feed 一个 Response 推进一步"做成了天然接口                                                     | 没有成熟三国杀实现采用                                                                                         |

### 1.2 论证

1. **"每 feed 一个 Response 推进一步"是联机与回放最自然的接口**,generator 天然就是这个接口,同时保留 async 的直线式可读性——它是 async 与显式状态机之间的帕累托最优点。
2. **显式状态机唯一的优势(续体可快照)用"回合边界快照 + 本回合应答"以可接受代价获得**(D3 + D9):回合边界的生成器栈恰好为空(顶层循环),`Game.fromState()` 能从该点重建生成器;恢复成本 = 一个回合内的应答数(几十条),同步毫秒级。代价(每个技能手写帧)会在 M3 补 25 名武将时持续放大,这是"少写代码、易读"目标下的明确取舍。
3. **相比 async,generator 把 `PlayerController` 推到核心之外**:`Game` 只认识 Request / Response。硬约束 3("引擎内禁止出现 UI / AI 逻辑")从纪律变成结构保证;`GameRunner`(async,约 25 行)负责 `controller.respond(request, view)` 并把 Response 喂回去。
4. **代价与缓解**:所有可能询问玩家的函数都必须是 `function*` 并用 `yield*` 调用,漏写 `yield*` 会静默不执行。`require-yield` **只能发现"生成器函数体内没有 yield"**,发现不了调用点漏写——所以用两层兜底(§11.4):① 自定义 typed-lint 规则 `flow-must-be-consumed`:返回类型为 `Flow<…>` 的调用表达式必须出现在 `yield*`、`return` 或赋值位置;② 运行时 `EngineOptions.detectUnconsumedFlows`:`runEvent()/ask()/moveCards()` 等工厂在创建生成器时登记一个 token,生成器体第一行注销;事件出栈与每个 Request 等待点若还有未注销 token 即抛 `EngineError('Flow created but never consumed')`。

### 1.3 运行形态

```ts
// 核心(同步)
const game = new Game(config, registry)
let r = game.start() // 推进到第一个 Request
while (r.type === 'request')
  r = game.step(
    await controllers[r.request.player].respond(r.request, game.viewFor(r.request.player)),
  )
// 真人 / AI / 远程都只实现 PlayerController;唯一的 async 点在 runner,不在核心
```

---

## 2. 核心类型

完整定义见 `docs/engine-core-types.draft.ts`,这里只讲设计意图。所有类型分五组:状态、牌与区域、事件、协议、注册表。

### 2.1 GameState 与"纯数据纪律"

```ts
interface GameState {
  schemaVersion: number
  seed: number
  rng: number // mulberry32 的 32 位状态,每次取随机数后写回
  mode: string
  phase: 'setup' | 'running' | 'over'
  players: PlayerState[] // 下标 = PlayerId = 座位号
  drawPile: CardId[]
  discardPile: CardId[]
  processing: CardId[] // drawPile 末尾 = 牌堆顶
  turn: TurnState | null
  turnCount: number
  lastTurnPlayer: PlayerId | null
  turnQueue: PlayerId[] // 额外回合队列(M3);顶层循环消费,保证回合边界栈空
  stack: GameEvent[] // 结算栈镜像:只含正在结算的事件,事件间只有 id 引用
  nextEventId: EventId
  nextRequestId: RequestId
  flags: Record<string, JsonValue> // 全局标记,@turn / @phase 生命周期
  result: GameResult | null
}
```

纪律(由 `state.test.ts` 的 JSON 往返测试与 `stateHash` 前的校验锁住):

- 不含函数、类实例、`Map/Set`、`Date`、`undefined`、`Infinity/NaN`;"无"一律 `null`。"无限次"用常量 `UNLIMITED = 1_000_000`。
- **日志不是状态**:`LogEntry` 由 `Game.log` 保存,不进 `GameState`、不进 `stateHash`,`StepResult.logs` 只给增量。这同时解决"视图携带全量 log 的 O(n²)"与"log 无限增长进哈希"。
- `PlayerState` 冗余 `kingdom` / `gender`(开局从 `GeneralDef` 写入):技能(护驾 / 救援 / 结姻)与视图直接读状态,不查 registry。
- `PlayerState.equips` 是固定四槽 `Record<EquipSlot, CardId | null>`,槽位顺序常量 `EQUIP_SLOTS` 决定技能收集与展示顺序。
- `flags`(私有,不进视图)与 `marks`(公开,进视图)的 key 以 `@turn` / `@phase` 结尾者由 `onTurn` / `onPhase` 的 `finally` 自动清除,其余持久;`turn.counters` 同约定。技能不再各自写清理代码。
- `turn.history: CardUseRecord[]` 记录本回合使用 / 打出的牌(含 `reason`),出杀次数、克己等查询只读它。

### 2.2 牌与区域

- 牌只用 `CardId`(静态牌表下标),静态 `CardSpec {id, name, suit, number}` 放 registry,由 `docs/data/standard-deck.md` 的 JSON(`DeckEntry`)派生。状态里只存 id ⇒ 序列化小、不变量计数简单。总牌数 = `registry.deck.length`(标准 108;按配置剔除 EX 后 104),不变量参数化。
- `CardFace {name, suit, number, subcards, viewAs}` 是"结算中被使用 / 打出的牌"。M1 恒为单张实体牌;M2 八卦阵"视为使用闪"、M3 转化技产出 `subcards.length !== 1` 的虚拟牌,引擎代码不改。
- `Zone` 六类;`moveCards()` 是**唯一**改变牌位置的入口,作为 `CardsMove` 事件运行;`position: 'top' | 'bottom'` 只对牌堆有意义(观星)。牌堆内部重排(`reorderDrawPile`)不是移动,不触发 `CardsMove`。
- `CardPattern` 是纯数据(可进 Request),`matchPattern(spec, pattern)` 在引擎与客户端共用。

### 2.3 事件对象与 id 引用(对底本的关键修正)

底本里 `CardEffect.use → CardUse`、`Damage.cause → CardEffect` 是对象引用并被就地突变,JSON 往返后引用变副本、身份丢失,"从 state 继续"不可行。定稿改为:

- `EventBase { kind, id, parentId, cancelled, tags }`;互相引用一律 `xxxId: EventId | null`(`useId / againstId / causeId / damageId / reasonId`)。
- 被引用的事件一定是栈上的祖先(子事件在父事件结算期间产生),`eventById(state, id)` 只在 `state.stack` 上线性查找;**不存在跨栈引用**。`AskCard.result` 改为纯数据 `{responded, card: CardFace | null}`,不再指向已出栈的子事件。
- 技能最常读的字段做冗余快照:`DamageEvent.card`、`RecoverEvent.card`、`DeathEvent.killer`。
- `tags: Record<string, JsonValue>` 是技能之间互通的扩展袋(如 `luoyi:boosted`),核心 handler 不读它;铁骑 / 无双 / 离间 / 仁王盾这类高频机制改用标准字段(`CardUse.responseCounts`、`CardEffect.requiredResponses / nullifiable / voided / responded`),避免 tags 蔓延成隐式协议。
- 日志只放 `JsonValue` 快照,**禁止 `data: ev`**(事件后续被突变会追溯修改日志)。

### 2.4 随机数(`core/rng.ts`)

mulberry32:`next(state) → [value, newState]`,状态存 `state.rng`;`Ctx.random() / randomInt(n) / shuffle(arr)` 是唯一随机源。Fisher–Yates 洗牌。控制器(随机 AI)用从 `(seed, player)` 派生的**独立** RNG,与引擎 RNG 隔离——否则 AI 的随机会扰动牌堆。

---

## 3. 事件模型与时机点完整清单

### 3.1 运行骨架(`core/engine.ts`、`core/flow.ts`)

```ts
export function* runEvent<K extends EventKind>(
  ctx: Ctx,
  draft: EventDraft<EventOf<K>>,
): Flow<EventOf<K>> {
  const s = ctx.state
  if (s.stack.length >= ctx.options.maxStackDepth) throw new EngineError('stack depth exceeded') // 技能互相触发死循环保护
  const ev = {
    ...draft,
    id: s.nextEventId++,
    parentId: top(s.stack)?.id ?? null,
    cancelled: false,
    tags: {},
  } as EventOf<K>
  s.stack.push(ev)
  let failed = false
  try {
    yield* (ctx.handlers[ev.kind] as EventHandler<EventOf<K>>)(ctx, ev)
  } catch (e) {
    failed = true
    throw e
  } finally {
    // finally 中禁止 yield
    s.stack.pop()
    if (!failed && ctx.options.assertInvariants) assertCardInvariant(ctx) // 异常在途时不断言,避免第二个异常掩盖原错误(含 GameOver)
  }
  return ev
}
/** 在时机点询问触发技;返回"事件是否仍有效",handler 写 if (!(yield* stage(...))) return */
export function* stage<T extends Timing>(
  ctx: Ctx,
  timing: T,
  ev: TimingEventMap[T],
): Flow<boolean> {
  yield* trigger(ctx, timing, ev)
  return !ev.cancelled
}
```

`handlers: EventHandlers` 是一张表(`events/index.ts`)。新增事件种类 = 加一个 kind + 一个 handler + `TimingEventMap` 若干行,不改 `runEvent / trigger`。`Timing` 由 `TimingEventMap` 的键派生,因此技能 `timings` 拼错即编译错误,且 `TriggerSkill<T>` 的 `canTrigger / effect` 自动按时机收窄事件类型。

### 3.2 M1 事件种类与时机点(顺序即 handler 内的触发顺序,由快照测试锁住)

| 事件          | 字段(除 id / parentId / cancelled / tags)                                                          | 时机点(按顺序)                                                                                                                                                                                                                                                                       | handler 要点                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GameStart`   | –                                                                                                  | `mode.setup()` → `Game.start`                                                                                                                                                                                                                                                        | setup:分配武将 / 身份、hp、洗牌或 `fixedDeckOrder`、发初始手牌(`DrawCards reason:'initial'`)、填 `turnQueue`                                                         |
| `Turn`        | player                                                                                             | `Turn.start` → 六个 `Phase` → `Turn.end`                                                                                                                                                                                                                                             | 置 `state.turn`;阶段循环中回合玩家死亡即 break;`finally` 清 `@turn` 标记、`turn = null`、`lastTurnPlayer`                                                            |
| `Phase`       | player, phase, skipped                                                                             | `Phase.before`(可取消 ⇒ 跳过;`skipPhases` 命中亦跳过)→ [`Phase.skipped`] 或 `Phase.start` → 阶段正文 → `Phase.end`                                                                                                                                                                   | 正文:prepare / finish 空;judge 见 §12c;draw = `DrawCards(2)`;play = 出牌循环(§11.2);discard = 超出手牌上限则 `chooseCards` + `moveCards`。`finally` 清 `@phase` 标记 |
| `DrawCards`   | player, count, reason, cards                                                                       | `DrawCards.before`(改 count:英姿 / 裸衣;取消:突袭)→ 摸 → `DrawCards.after`                                                                                                                                                                                                           | 逐张 `ensureDrawPile` + `moveCards`;牌堆空则弃牌堆洗入牌堆底;两者皆空 ⇒ 平局结束                                                                                     |
| `CardsMove`   | moves[]                                                                                            | `CardsMove.before` → 原子移动 → `CardsMove.after`                                                                                                                                                                                                                                    | 唯一改牌位置的地方;日志按可见性分组(§8);装备槽被占时调用方先移走旧装备                                                                                               |
| `AskCard`     | player, pattern, mode, targets, againstId, reasonId, prompt, result                                | `AskCard.before`(八卦阵 / 护驾填 result;铁骑取消)→ [有候选才发 Request] → 执行 `CardUse` 或 `CardRespond` → `AskCard.after`                                                                                                                                                          | 返回 `AskCardResult`;显式 `targets` 优先于 `CardDef.target.auto`;无符合牌且无转化技时不发 Request                                                                    |
| `CardUse`     | source, card, targets, currentTarget, reason, againstId, nullifiable, responseCounts               | 牌入处理区 → `CardUse.before` → `CardUse.targeting`(使用者增减目标)→ 对每个目标 `CardUse.targeted`(目标侧,可转移:流离)→ 对每个目标 `CardUse.targetSpecified`(铁骑 / 无双)、`CardUse.targetConfirmed` → `CardUse.using`(集智)→ 逐目标 `CardEffect` → `CardUse.after` → 残留牌入弃牌堆 | 写 `turn.history`;目标顺序 = 从使用者起座位序(§12f);零目标 ⇒ 一个 `target: null` 的 `CardEffect`;轮到时已死亡的目标跳过                                              |
| `CardRespond` | player, card, againstId, reasonId                                                                  | 牌入处理区 → `CardRespond.before` → `CardRespond.after` → 残留牌入弃牌堆                                                                                                                                                                                                             | 打出:不产生 `CardEffect`(决斗 / 南蛮要求的杀)                                                                                                                        |
| `CardEffect`  | useId, card, source, target, delayed, nullifiable, nullified, voided, responded, requiredResponses | [nullifiable ⇒ 无懈链 §12b] → [仁王盾 `fold('nullifyEffect')`] → 若 nullified/voided:`CardEffect.nullified` + `def.onNullified` 并返回 → `CardEffect.before` → `def.effect` → `CardEffect.after`                                                                                     | 单目标单效果;`nullifiable` 创建时按(牌类型, delayed)填:即时锦囊 = `use.nullifiable`,延时锦囊使用时 false、判定阶段 `def.nullifiable`                                 |
| `Damage`      | from, to, amount, nature, card, causeId                                                            | [目标已死亡 ⇒ 取消] → `Damage.caused`(来源侧改量:裸衣)→ `Damage.inflicted`(受方防止 / 改量)→ 扣血 → [hp ≤ 0 ⇒ `Dying`] → `Damage.done`(奸雄 / 反馈 / 刚烈 / 遗计)→ `Damage.after`                                                                                                    | 濒死在"受到伤害后"之前结算,与官方一致;`Damage.done / after` 不可取消                                                                                                 |
| `LoseHp`      | player, amount, reasonId                                                                           | `LoseHp.before` → 扣血 → [hp ≤ 0 ⇒ `Dying`] → `LoseHp.after`                                                                                                                                                                                                                         | 苦肉(M3);M1 只有 handler                                                                                                                                             |
| `Recover`     | to, amount, source, card, causeId                                                                  | `Recover.before`(救援 +1)→ 回血(≤ maxHp)→ `Recover.after`                                                                                                                                                                                                                            |                                                                                                                                                                      |
| `Dying`       | player, damageId                                                                                   | `Dying.enter` → 求桃循环 → `Dying.after` → [hp ≤ 0 ⇒ `Death`]                                                                                                                                                                                                                        | §12a                                                                                                                                                                 |
| `Death`       | player, killer, damageId                                                                           | `Death.before` → 标记死亡 / 亮身份 → `mode.checkWinner`(胜负 ⇒ `GameOver`)→ `Death.after` → `mode.onDeath`(奖惩)→ 弃置全部牌(`reason:'bury'`)                                                                                                                                        | 顺序与 QSanguosha 的 GameOverJudge → Death → BuryVictim 一致                                                                                                         |
| `Judge`       | player, reason, pattern, card, matched, retrialBy                                                  | `Judge.before` → `peekDrawPile(1)` + 牌入处理区 → `Judge.cardShown`(鬼才改判)→ 算 matched → `Judge.result`(天妒 / 洛神取走判定牌)→ `Judge.after` → 判定牌若仍在处理区则入弃牌堆                                                                                                      | M1 实现 handler,M2 乐 / 闪电 / 八卦阵直接用                                                                                                                          |

M3 预计新增的事件种类:`Pindian`(标准 25 将不需要)、`ChangeMaxHp`(标准 25 将不需要)。两者都是"加表项"。

### 3.3 关键 handler 伪代码

```ts
// events/game.ts ─ 顶层循环:回合边界是唯一的快照点(栈为空)
function* runGame(ctx: Ctx): Flow<void> {
  const s = ctx.state
  try {
    if (s.phase === 'setup') { yield* runEvent(ctx, { kind: 'GameStart' }); s.phase = 'running' }
    for (;;) {
      if (s.turnCount >= ctx.options.maxTurns) gameOver(ctx, { winners: [], reason: 'maxTurns' })
      const next = s.turnQueue.shift() ?? nextAlive(s, s.lastTurnPlayer)        // 额外回合由队列驱动,不嵌套在上一回合内
      ctx.onTurnBoundary()                                                       // Game 在此克隆 base 快照(§9.3)
      yield* runEvent(ctx, { kind: 'Turn', player: next })
    }
  } catch (e) { if (e instanceof GameOver) return; throw e }                    // gameOver() 先写 state.result / phase 再 throw
}
function* onTurn(ctx, ev: TurnEvent) {
  const s = ctx.state
  s.turn = { player: ev.player, phase: null, skipPhases: [], history: [], counters: {} }; s.turnCount++
  try {
    if (!(yield* stage(ctx, 'Turn.start', ev))) return
    for (const phase of PHASES) {
      if (!playerOf(ctx, ev.player).alive) break
      yield* runEvent(ctx, { kind: 'Phase', player: ev.player, phase, skipped: false })
    }
    yield* stage(ctx, 'Turn.end', ev)
  } finally { clearScopedFlags(s, '@turn'); s.lastTurnPlayer = ev.player; s.turn = null }   // 无 yield
}
function* onPhase(ctx, ev: PhaseEvent) {
  const t = ctx.state.turn!
  if (t.skipPhases.includes(ev.phase)) ev.skipped = true                         // 乐不思蜀
  const ok = yield* stage(ctx, 'Phase.before', ev)                               // 克己:置 cancelled ⇒ 跳过弃牌阶段
  if (!ok || ev.skipped) { ev.skipped = true; ctx.log({ type: 'phaseSkipped', … }); yield* stage(ctx, 'Phase.skipped', ev); return }
  t.phase = ev.phase
  try {
    if (!(yield* stage(ctx, 'Phase.start', ev))) return
    yield* PHASE_BODY[ev.phase](ctx, ev.player)
    yield* stage(ctx, 'Phase.end', ev)
  } finally { clearScopedFlags(ctx.state, '@phase'); t.phase = null }
}

// events/cards.ts
function* onCardUse(ctx, ev: CardUseEvent) {
  const def = ctx.registry.card(ev.card.name)!
  yield* moveCards(ctx, ev.card.subcards.map(card => ({ card, to: { kind: 'processing' }, reason: 'use' })))
  ctx.state.turn?.history.push({ player: ev.source, card: ev.card.name, mode: 'use', reason: ev.reason, phase: ctx.state.turn.phase })
  try {
    if (!(yield* stage(ctx, 'CardUse.before', ev))) return
    if (!(yield* stage(ctx, 'CardUse.targeting', ev))) return
    for (const t of orderTargets(ctx.state, ev.source, ev.targets)) { ev.currentTarget = t; yield* stage(ctx, 'CardUse.targeted', ev) }
    for (const t of orderTargets(ctx.state, ev.source, ev.targets)) {
      ev.currentTarget = t; yield* stage(ctx, 'CardUse.targetSpecified', ev); yield* stage(ctx, 'CardUse.targetConfirmed', ev)
    }
    ev.currentTarget = null
    if (!(yield* stage(ctx, 'CardUse.using', ev))) return
    const targets: Array<PlayerId | null> = ev.targets.length === 0 ? [null] : orderTargets(ctx.state, ev.source, ev.targets)
    for (const target of targets) {
      if (target !== null && !playerOf(ctx, target).alive) continue
      yield* runEvent(ctx, { kind: 'CardEffect', useId: ev.id, card: ev.card, source: ev.source, target, delayed: false,
        nullifiable: def.type === 'delayed_trick' ? false : ev.nullifiable, nullified: false, voided: false, responded: false,
        requiredResponses: target === null ? 0 : (ev.responseCounts[String(target)] ?? fold(ctx, 'requiredResponses', 1, ev, target)) })
    }
    yield* stage(ctx, 'CardUse.after', ev)
  } finally { /* 无 yield */ }
  const residual = ev.card.subcards.filter(c => zoneOf(ctx.state, c).kind === 'processing')     // 奸雄拿走的、进装备区 / 判定区的都不在
  if (residual.length) yield* moveCards(ctx, residual.map(card => ({ card, to: { kind: 'discard' }, reason: 'use' })))
}
function* onCardEffect(ctx, ev: CardEffectEvent) {
  const def = ctx.registry.card(ev.card.name)!
  if (ev.nullifiable) yield* resolveNullification(ctx, ev)                                     // §12b
  if (!ev.nullified && ev.target !== null && fold(ctx, 'nullifyEffect', false, ev)) ev.voided = true   // 仁王盾
  if (ev.nullified || ev.voided) {
    ctx.log({ type: ev.nullified ? 'nullified' : 'effectVoid', … }); yield* stage(ctx, 'CardEffect.nullified', ev)
    if (def.onNullified) yield* def.onNullified(ctx, ev); return
  }
  if (!(yield* stage(ctx, 'CardEffect.before', ev))) return
  if (def.effect) yield* def.effect(ctx, ev)
  yield* stage(ctx, 'CardEffect.after', ev)
}
function* onAskCard(ctx, ev: AskCardEvent) {
  if (!(yield* stage(ctx, 'AskCard.before', ev))) return                                      // 铁骑:取消 ⇒ 不能响应;八卦阵:写 result
  if (!ev.result.responded) {
    const candidates = matchingCards(ctx, ev.player, ev.pattern), viewAsSkills = viewAsOptions(ctx, ev.player, ev.pattern, ev.mode)
    if (candidates.length > 0 || viewAsSkills.length > 0) {                                   // 无牌可出不发 Request(只依赖状态,确定)
      const r = yield* ask(ctx, { kind: 'askCard', player: ev.player, pattern: ev.pattern, mode: ev.mode, candidates, viewAsSkills,
                                  fixedTargets: ev.targets, targets: null, against: ev.againstId, reason: ev.reasonId, prompt: ev.prompt })
      const face = r.card !== null ? faceOf(ctx, r.card) : r.viewAs !== null ? viewAsFace(ctx, ev.player, r.viewAs, ev.pattern) : null
      if (face) {
        if (ev.mode === 'use') yield* runEvent(ctx, { kind: 'CardUse', source: ev.player, card: face, targets: ev.targets, currentTarget: null,
                                                     reason: 'response', againstId: ev.againstId, nullifiable: defaultNullifiable(ctx, face), responseCounts: {} })
        else yield* runEvent(ctx, { kind: 'CardRespond', player: ev.player, card: face, againstId: ev.againstId, reasonId: ev.reasonId })
        ev.result = { responded: true, card: face }
      }
    }
  }
  yield* stage(ctx, 'AskCard.after', ev)
}
```

`Damage / Dying / Death / Judge` 的伪代码见 §12。

---

## 4. 结算栈规则

1. **栈 = 生成器调用栈的数据镜像**:`runEvent` 压栈、`finally` 出栈;`parentId` 由栈顶推导。`state.stack` 的用途:推导 `parentId`、技能查询"当前正在结算的事件"、`PlayerView.stack` 展示"你在响应什么"、`eventById` 查找。
2. **事件之间只有 id 引用,且只引用祖先**(D3)。`eventById(state, id)` 在栈上找不到即返回 `null`,技能必须处理 `null`。
3. **取消语义**:任一时机的技能可置 `ev.cancelled = true`;`stage()` 返回 `!ev.cancelled`,handler 在每个可取消时机后检查并提前返回。不可取消的时机(`Damage.done/after`、`*.after`)忽略该标志。各事件的可取消点见 §3.2 表。
4. **栈不能"跳"**:没有 break 到祖先的能力;想中止祖先事件只能标记其 `cancelled`,祖先在自己的下一个 `stage()` 后自行返回。唯一的异常式控制流是 `GameOver`(§4.6)。
5. **出栈断言**:无异常在途时断言总牌数不变量(每张牌恰好出现一次);`Game.step` 的每个 Request 等待点再断言一次。失败即定位到具体事件。
6. **`GameOver`**:`gameOver(ctx, result)` 先写 `state.result` 与 `state.phase = 'over'` 再 `throw new GameOver()`,异常穿过所有 `finally`(只做出栈,不做断言、不 `yield`)到 `runGame` 被吞掉;`Game.step` 返回 `{type:'over'}`。此后任何 `step()` 抛错。
7. **`finally` 中禁止 `yield`**:所有"善后移牌"(残留牌入弃牌堆等)写在正常流程里;对局已结束时状态保持原样(不变量仍成立,因为 `CardsMove` 是原子的)。
8. **非 `GameOver` 异常**(技能 bug、断言失败)会杀死生成器:`Game` 捕获后置 `broken = true`,之后 `step()` 一律抛 `EngineBrokenError`。单测 / 模拟器直接失败;服务端(M7)用最近的回合边界快照 `Game.restore()` 回滚并按产品策略处理(重试默认应答或判平局)。
9. **深度上限**:`options.maxStackDepth`(默认 256)防技能互相触发死循环;`options.maxTurns` 防整局死循环。
10. **时机脚本固定**:每个 handler 内的时机顺序是公共契约,`timings.snapshot.test.ts` 用"记录型技能"(订阅全部时机,把 `timing + kind` 写入数组)跑固定脚本并 `toMatchSnapshot()` 锁住(PLAN 风险 1)。

嵌套示例(杀 → 伤害 → 濒死 → 求桃 → 死亡),栈自底向上:

```
Turn(1) ─ Phase(play) ─ CardUse(slash, 1→2) ─ CardEffect(target 2)
                                              ├─ AskCard(2, jink) … 玩家 2 没出闪
                                              └─ Damage(1→2, 1)
                                                   └─ Dying(2)
                                                        ├─ AskCard(1, peach) ─ CardUse(peach) ─ CardEffect ─ Recover(2, +1)   // hp 仍 ≤ 0 继续问同一人
                                                        ├─ AskCard(2, peach) … AskCard(n, peach)
                                                        └─ Death(2) ─ [checkWinner] ─ mode.onDeath ─ CardsMove(bury)
```

---

## 5. Request / Response 协议(唯一交互出口)

### 5.1 请求种类

| kind            | 用途                                     | 关键字段(Request)                                                                                                    | Response                                                                                                  |
| --------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `play`          | 出牌阶段                                 | `usableCards: {card, targets: TargetSpec}[]`、`usableSkills: {skill, kind:'active'\|'viewAs', as, cards, targets}[]` | `{action:'useCard', card, targets}` / `{action:'useSkill', skill, as, cards, targets}` / `{action:'end'}` |
| `askCard`       | 响应闪 / 桃 / 无懈 / 决斗的杀 / 借刀的杀 | `pattern, mode, candidates: CardId[], viewAsSkills, fixedTargets, targets: TargetSpec \| null, against`              | `{card \| null, viewAs: {skill, cards} \| null, targets}`                                                 |
| `chooseCards`   | 弃牌、技能选牌、过河拆桥 / 顺手牵羊盲选  | `candidates: {index, card: CardId \| null, zone}[]`, `min, max, cancellable`                                         | `{indices: number[]}`(以 index 回传,他人手牌不暴露 id)                                                    |
| `choosePlayers` | 技能选人(M3)                             | `candidates, min, max, cancellable`                                                                                  | `{players}`                                                                                               |
| `choice`        | 多选一                                   | `options: string[], cancellable`                                                                                     | `{option}`                                                                                                |
| `invokeSkill`   | 是否发动 / 先发动哪个触发技              | `skills: SkillId[]`(1 个 = 是否发动;多个 = 选一个先发动),`event: EventId`                                            | `{skill \| null}`                                                                                         |
| `arrange`       | 排列牌(观星:分到牌堆顶 / 底并排序,M3)    | `cards: CardId[], slots: {id, min, max}[]`                                                                           | `{placement: Record<slotId, CardId[]>}`                                                                   |

共有字段:`id`(`state.nextRequestId++`,可复现)、`player`、`prompt: {key, args}`(可本地化,引擎内**没有中文文案**)、`reason: EventId | null`(客户端在 `PlayerView.stack` 里找摘要)。

原则:**候选集由引擎算好**(`usableCards / candidates / targets`),远程客户端与 AI 无需引擎即可渲染与决策;`validateResponse` 用同一套函数复核。这 7 种 kind 覆盖标准版 25 名武将与全部标准牌;新增 kind 需要改 `core/types.ts` 的联合 + `validate.ts` + `defaultResponse`(三处,"加表项"级别),已在 §10.4 列明。

### 5.2 `Game.step` 的校验与非法应答策略

```ts
step(response: Response): StepResult {
  if (this.broken) throw new EngineBrokenError(); if (!this.pending) throw new EngineError('no pending request')
  const verdict = validateResponse(this.ctx, this.pending, response)      // id / kind 匹配、牌在候选内、目标在 TargetSpec 内且满足 filter、数量范围…
  let effective = response
  if (!verdict.ok) {
    if (this.options.invalidResponsePolicy === 'throw') throw new InvalidResponseError(verdict.reason)   // 生成器不前进,Runner 可重发同一 Request
    effective = defaultResponse(this.pending); this.appendLog({ type: 'invalidResponse', data: { requestId: this.pending.id, reason: verdict.reason }, visibleTo: null, eventId: null })
  }
  this.allResponses.push(effective); this.responsesSinceBase.push(effective)   // 只记录"生效"的应答,回放只认它
  return this.advance(effective)
}
```

- `defaultResponse(request)` 是确定性的:`play → end`、`askCard → card: null`、`chooseCards → 按 index 取前 min 张`、`choosePlayers → 前 min 个`、`choice → options[0]`、`invokeSkill → null`、`arrange → 按顺序填满各槽的 min`。远程超时 / 断线由服务端用它生成一条**正常 Response** 喂入,因此回放与超时无关。
- `'throw'` 策略下非法应答不进 `responses`;`'default'` 策略下记录的是替换后的应答。策略在 `GameConfig.options` 中,随快照保存,回放一致。
- 校验与候选共用同一函数(`usableCards / legalTargets / matchingCards`),不存在"两处真相"。

### 5.3 帮助函数(`core/flow.ts`)

```ts
export function* ask<K extends RequestKind>(ctx: Ctx, draft: RequestDraft<K>): Flow<ResponseOf<K>> {
  const resp = yield { ...draft, id: ctx.state.nextRequestId++ } as Request
  return resp as ResponseOf<K>
}
export function* askCard(
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
```

### 5.4 `Game` 对外 API、Runner 与控制器

```ts
class Game implements GameApi {
  constructor(config: GameConfig, registry: Registry)
  static fromState(state: GameState, registry: Registry, config: GameConfig): Game // 要求 state.stack.length === 0 且 phase !== 'over'
  static restore(snapshot: Snapshot, registry: Registry): Game // 版本门禁 + 同步 step 回放(§9.3)
  start(): StepResult
  step(response: Response): StepResult
  get state(): GameState
  get pending(): Request | null
  get log(): readonly LogEntry[]
  get responses(): readonly Response[]
  viewFor(player: PlayerId): PlayerView
  stateHash(): string
  snapshot(): Snapshot
}
interface PlayerController {
  respond(request: Request, view: PlayerView): Promise<Response> | Response
  notify?(view: PlayerView, logs: LogEntry[]): void
}
export async function runGame(game: Game, controllers: PlayerController[]): Promise<GameResult> {
  let r = game.start()
  for (;;) {
    controllers.forEach((c, i) => c.notify?.(game.viewFor(i), visibleTo(r.logs, i))) // 只下发增量日志
    if (r.type === 'over') return r.result
    const { player } = r.request
    r = game.step(await controllers[player]!.respond(r.request, game.viewFor(player)))
  }
}
```

`runGame` 是引擎包里唯一的 `async` 代码,放在 `core/runner.ts`,核心模块不 import 它。

---

## 6. 触发技:收集、排序、询问(`core/trigger.ts`)

```ts
function* trigger<T extends Timing>(ctx: Ctx, timing: T, ev: TimingEventMap[T]): Flow<void> {
  const fired: Record<string, number> = {}            // `${player}:${skill}` → 已发动次数
  const declined = new Set<string>()                  // 本时机已拒绝(只做成员判断,不遍历)
  for (const prio of ctx.registry.triggerPriorities(timing)) {               // 降序桶
    scan: for (;;) {
      for (const p of playersFrom(ctx.state, anchor(ctx.state))) {           // 从当前回合玩家起座位序,含死者
        const cands = skillsOf(ctx, p.id)
          .filter((s): s is TriggerSkill => s.type === 'trigger' && s.priority === prio && s.timings.includes(timing))
          .filter(s => (p.alive || s.triggerWhenDead) && !declined.has(key(p.id, s.id)))
          .filter(s => (fired[key(p.id, s.id)] ?? 0) < (s.times?.(ctx, ev, p.id) ?? 1))
          .filter(s => s.canTrigger(ctx, ev, p.id))
        if (cands.length === 0) continue
        const locked = cands.filter(s => s.locked)
        let chosen: TriggerSkill | null
        if (locked.length > 0) chosen = locked[0]!                                           // 锁定技:不询问、按 skillsOf 顺序
        else {
          const r = yield* ask(ctx, { kind: 'invokeSkill', player: p.id, skills: cands.map(s => s.id), event: ev.id, reason: ev.id, prompt: … })
          chosen = r.skill === null ? null : cands.find(s => s.id === r.skill) ?? null
        }
        if (chosen === null) { cands.forEach(s => declined.add(key(p.id, s.id))); continue }
        fired[key(p.id, chosen.id)] = (fired[key(p.id, chosen.id)] ?? 0) + 1
        ctx.log({ type: 'skillInvoked', data: { player: p.id, skill: chosen.id, eventId: ev.id }, visibleTo: null, eventId: ev.id })
        yield* chosen.effect(ctx, ev, p.id)
        if (ev.cancelled) return
        continue scan                                                                         // 状态已变:从当前回合玩家重新扫描(已处理的被 fired/declined 跳过)
      }
      break
    }
  }
}
```

排序规则(7d):

1. **优先级桶**(`priority`,大者先,默认 0):跨玩家生效,供规则类技能(身份局奖惩、"先于其他技能结算"的文本)使用;`registry.triggerPriorities(timing)` 预建、降序、恒含 0。
2. **座位序**:从当前回合玩家起顺时针(`anchor = state.turn?.player ?? 0`,回合玩家已死也以其座位为起点);无回合时从 0 号位。
3. **同一玩家**:锁定技先(按 `skillsOf` 顺序,不询问);然后可选技由玩家通过 `invokeSkill` 选择先发动哪个(单个 = 是否发动)。`priority` 对可选技只影响桶,不替玩家排序。
4. **多次触发**:`times(ctx, ev, owner)`(缺省 1)控制同一事件同一时机的最多发动次数(遗计 = 伤害点数);拒绝一次即本时机内不再询问该技能(`declined` 永久)。
5. **重扫**:每发动一次从头重扫(已发动 / 已拒绝的被跳过),因为技能可能改变事件数据或触发条件;事件被取消即终止。
6. **死亡玩家**默认不参与,`triggerWhenDead` 显式开启;"事件目标可能已死"是技能作者的责任(`canTrigger` 里查 `alive`)。
7. **`skillsOf(ctx, p)` 的顺序是数据声明序**:`GeneralDef.skills` 声明序 → `PlayerState.skills` 中额外获得的技能 → 装备按 `EQUIP_SLOTS` 槽序各自的 `equip.skills`。不依赖模块 import 顺序,版本间稳定;主公技只在 `mode.lordSkillsEnabled()` 为真时参与。

---

## 7. 修正技机制(`core/modifiers.ts`)

```ts
export function fold<K extends ModifierKey>(
  ctx: Ctx,
  hook: K,
  base: HookValue<K>,
  ...args: HookArgs<K>
): HookValue<K> {
  let value = base
  for (const p of ctx.state.players)
    // 座位 0 起(与回合无关),再按 skillsOf 顺序:固定且确定
    for (const s of skillsOf(ctx, p.id))
      if (s.type === 'modifier') {
        const h = s.modifiers[hook]
        if (h) value = (h as ModifierHook<HookValue<K>, HookArgs<K>>)(ctx, p.id, value, ...args)
      }
  return value
}
```

钩子表(`ModifierHooks`,内容包可用 `declare module '@sgs/engine' { interface ModifierHooks { … } }` 增加键,核心只认识 `fold`):

| 钩子                | 签名(ctx, owner, value, …args)     | 基值                           | 使用者(M2 / M3)                        |
| ------------------- | ---------------------------------- | ------------------------------ | -------------------------------------- |
| `attackRange`       | `(…, value, subject)`              | 武器 `equip.range`,无武器 1    | (标准版无;武器不走钩子)                |
| `distanceFrom`      | `(…, value, from, to)`             | −1 马 `equip.distance`(−1)或 0 | 马术                                   |
| `distanceTo`        | `(…, value, from, to)`             | +1 马 `equip.distance`(+1)或 0 | –                                      |
| `useLimit`          | `(…, value, subject, card)`        | 杀 1,其余 `UNLIMITED`          | 诸葛连弩、咆哮                         |
| `maxHandCards`      | `(…, value, subject)`              | hp                             | (标准版无)                             |
| `ignoreDistance`    | `(…, value, subject, card)`        | false                          | 奇才                                   |
| `extraTargets`      | `(…, value, subject, card)`        | 0                              | 方天画戟                               |
| `prohibitTarget`    | `(…, value, source, target, card)` | false                          | 空城、谦逊                             |
| `nullifyEffect`     | `(…, value, effect)`               | false                          | 仁王盾                                 |
| `requiredResponses` | `(…, value, use, target)`          | 1                              | 无双(铁骑用 `use.responseCounts` 置 0) |

派生查询(`core/state.ts`):

```
weaponRange(p)        = equips.weapon ? registry.card(spec(weapon).name).equip.range : 1
attackRange(p)        = fold('attackRange', weaponRange(p), p)
distance(a, b)        = max(1, seatDistance(存活环, a, b) + fold('distanceFrom', horseOffensive(a), a, b) + fold('distanceTo', horseDefensive(b), a, b))
inAttackRange(a, b)   = distance(a, b) <= attackRange(a)
useLimit(p, card)     = fold('useLimit', card.name === 'slash' ? 1 : UNLIMITED, p, card)
usedInPlay(p, name)   = turn.history.filter(h => h.player === p && h.card === name && h.reason === 'play' && h.mode === 'use').length
maxHandCards(p)       = fold('maxHandCards', hp(p), p)
legalTargets(u, card) = 存活玩家 − (excludeSelf ? u) − 距离 / 攻击范围不满足(除非 fold('ignoreDistance')) − fold('prohibitTarget') − !def.target.filter;max += fold('extraTargets')
```

要点:

- **武器射程是基值不是钩子**(修正了底本 `Math.max(v, 3)` 的"置为"语义错误);**坐骑是纯数据**(`CardDef.equip.distance`),不需要注册技能。
- **出杀次数只统计 `reason === 'play'` 的使用**(出牌阶段 play 请求发起);借刀杀人 / 激将令其使用的杀 `reason` 为 `'response' / 'skill'`,不消耗次数(修正底本的 `counters['used:sha']` 全局计数)。
- 装备技能由 `equips` 现算(`skillsOf`),没有"挂载 / 卸载"状态可失同步。
- 折叠顺序固定但钩子应写成与顺序无关(加减 / 或 / 取极值);需要"置为"语义的未来钩子用独立的 `fixed*` 键表达(§15)。

---

## 8. 信息隐藏(`core/view.ts`)

```ts
interface PlayerView {
  me: PlayerId
  role: Role
  hand: CardId[] // 只有自己的手牌
  players: PublicPlayerView[] // 他人:handCount、equips、judgeArea、role | 'hidden'、skills、marks
  drawPileCount: number
  discardPile: CardId[]
  processing: CardId[]
  turn: TurnState | null
  turnCount: number
  stack: EventSummary[] // 遮蔽后的结算栈摘要:"你在响应什么"
  waitingFor: PlayerId | null
  result: GameResult | null
}
```

规则:

1. `viewFor(p)` 是纯函数,只读 `GameState`;单测断言"B 的 view 中不含 A 的手牌 id"。
2. 身份可见性由 `mode.roleVisible(ctx, viewer, target)` 决定:自己可见、主公可见、已死亡者可见、其余 `'hidden'`(M3 身份局);M1 FFA 全为 `'none'`。
3. **Request 不泄露**:`askCard.candidates` 只含本人的牌;`chooseCards` 对他人手牌给 `{index, card: null, zone}`,应答以 `indices` 回传;`invokeSkill` 只带 `event: EventId`,客户端只能看到该事件的遮蔽摘要。
4. **`EventSummary` 遮蔽**:`CardsMove / DrawCards` 事件不进摘要;`AskCard` 摘要不含 `pattern / candidates`(他人可据此推断手牌)。
5. **日志按可见性分组**:`CardsMove` 的每条移动有 `visibleTo`(牌堆 ↔ 手牌:仅 owner;手牌 → 手牌:双方;其余公开),`logMoves` 按可见性分组写多条 `LogEntry`,隐藏条目只给数量;`notify()` 只下发 `visibleTo` 含该玩家的增量日志。
6. **`CardId` 是静态牌表下标,等价于明牌**:守则是"任何隐藏牌一律不以 id 出现在他人的 view / Request / log 中"。`view.hidden.test.ts` 的 fuzz 用例:构造隐藏牌 id 与公开牌 id 不相交的状态,对每个等待点 `JSON.stringify(viewFor(p))` 与发给 p 的 Request / 日志,断言不含任何隐藏 id 的数字字面量。若未来需要更强的防御(观看他人手牌后再洗回牌堆的关联推断),在 setup 时对 id 做一次种子置换即可,状态结构不变(§15)。
7. **"无牌不问"的时序泄露**(§3.3 `onAskCard`):引擎跳过无候选者的 Request,联机时其他玩家能从"谁被问了"推断谁没有无懈 / 桃。FreeKill 同样如此;遮蔽属于 UI / 服务端策略(随机延迟),不在引擎内处理(§15)。

---

## 9. 确定性、回放与存档

### 9.1 确定性清单(结构保证,非纪律)

1. 随机源唯一:`Ctx.random/randomInt/shuffle`,状态在 `state.rng`;控制器自带种子。
2. 输入唯一:Response 序列;Request id / Event id 来自状态计数器。
3. 遍历一律座位序 / 数据声明序;`flags / marks / counters` 只做 key 读写不遍历;排序一律显式比较器。
4. 引擎包 eslint:`no-restricted-globals: Date`、`no-restricted-properties: Math.random`、禁止 `Promise` 出现在 `core/ events/ cards/` 目录(除 `runner.ts`)。
5. 状态校验:`stateHash()` 前检查无 `Infinity / NaN / undefined`(规范化 JSON:键排序、数组保序);`UNLIMITED` 代替 `Infinity`。
6. 测试:`replay.test.ts` 固定种子跑随机 AI 一局记录 responses → `restore` 回放 → `stateHash` 相等;再跑 200 个种子;`serialize-resume.test.ts` 在每个回合边界 `snapshot → restore` 后继续跑,与不中断的结果 hash 一致。

### 9.2 回放(M6 录像)

`Snapshot { engineVersion, schemaVersion, contentHash, config, base: null, responses: 全部, log }`。`Game.restore` = `new Game(config)` + 同步 `step` 每条 response。`ReplayController`(控制器层)也可用它逐步播放;`stateHash()` 在任意等待点比对。

### 9.3 中途存档(7h):回合边界快照 + 本回合应答

- `runGame` 的顶层循环每次进入 `Turn` 前调用 `ctx.onTurnBoundary()`,此时 `state.stack.length === 0`;`Game` 在此深克隆 `state` 为 `base`,并清空 `responsesSinceBase`。
- `Game.snapshot()` 返回 `{…, base, responses: responsesSinceBase}`;开局到第一个回合边界之前 `base = null`(退化为全量回放)。
- `Game.restore(snapshot)`:版本门禁(§9.5)→ `Game.fromState(base)`(新建 `runGame` 生成器,`phase === 'running'` 时跳过 `GameStart` 直接进入回合循环)→ `start()` → 逐条 `step()` → 恢复到最后一个未应答的 Request(Runner 再问一次即可;联机重连只需重发 `pending`)。
- 恢复成本 O(本回合应答数),同步毫秒级;服务端重启上万局也只需各回放一个回合。
- 额外回合(M3)由顶层循环从 `turnQueue` 取,不嵌套在上一回合内,保证边界的前提成立。
- 这一路径之所以可行,全靠 D3(state 是真正可恢复的纯数据)——这是定稿与底本最重要的差异。

### 9.4 联机服务端权威(M7 的接口已就绪)

服务端持有 `Game`;收到 Response → `step()` → 把下一个 Request 与对应 `viewFor()` 发给该玩家,其余玩家收 `notify` 增量;超时 / 断线 → `defaultResponse(pending)` 作为正常 Response 喂入;重连 → 重发 `pending` + view;分叉检测 → 客户端 `stateHash` 与服务端比对(客户端只渲染日志,不复算隐藏信息)。

### 9.5 版本门禁

`Snapshot.engineVersion`(包版本)、`schemaVersion`(`STATE_SCHEMA_VERSION`)、`contentHash`(registry 由已注册 id + 各 `ContentPackage.version` 计算)。`restore` 要求三者一致;不一致时抛 `IncompatibleSnapshotError`,调用方可退回全量回放快照(若保存了)或放弃。内容补丁只会让**当前回合**的应答失效(`InvalidResponseError`),而不是整局——这是回合边界快照相对全量回放的核心收益。

---

## 10. Registry 与内容定义方式

### 10.1 注册表

```ts
const registry = createRegistryBuilder()
  .setDeck(STANDARD_DECK /* docs/data JSON */)
  .use(standardM1)
  .build()
// build():校验 id 唯一、引用的技能 / 牌 / 武将存在、timings ∈ Timing、GeneralDef.skills 存在;预建 timing → 技能索引与优先级桶;计算 contentHash;冻结
```

Registry 是**实例**不是全局单例:核心单测注入假牌 / 假技能隔离测试 `trigger / fold / view`,不依赖真实内容。

### 10.2 内容定义示例(M1 三张基本牌)

```ts
// cards/basic.ts
export const slash: CardDef = {
  name: 'slash',
  type: 'basic',
  equip: null,
  judgePattern: null,
  nullifiable: false,
  target: { min: 1, max: 1, auto: null, range: 'attack', excludeSelf: true },
  canUse: (ctx, user, card) => usedInPlay(ctx, user, 'slash') < useLimit(ctx, user, card),
  *effect(ctx, eff) {
    const target = eff.target!
    let dodged = eff.requiredResponses > 0 // 0 = 不可响应(铁骑)
    for (let i = 0; i < eff.requiredResponses; i++) {
      // 2 = 需两张闪(无双)
      const r = yield* askCard(ctx, {
        player: target,
        pattern: byName('jink'),
        mode: 'use',
        targets: [],
        againstId: eff.id,
        reasonId: eff.id,
        prompt: { key: 'ask.jink', args: { source: eff.source ?? -1 } },
      })
      if (!r.responded) {
        dodged = false
        break
      }
    }
    if (dodged) {
      eff.responded = true
      return
    } // 青龙偃月刀 / 贯石斧在 CardEffect.after 读 responded
    yield* runEvent(ctx, {
      kind: 'Damage',
      from: eff.source,
      to: target,
      amount: 1,
      nature: 'normal',
      card: eff.card,
      causeId: eff.id,
    })
  },
}
export const jink: CardDef = {
  name: 'jink',
  type: 'basic',
  equip: null,
  judgePattern: null,
  nullifiable: false,
  target: { min: 0, max: 0, auto: null, range: null, excludeSelf: false },
  canUse: () => false,
} // 仅作响应;无 effect
export const peach: CardDef = {
  name: 'peach',
  type: 'basic',
  equip: null,
  judgePattern: null,
  nullifiable: false,
  target: { min: 0, max: 0, auto: 'self', range: null, excludeSelf: false },
  canUse: (ctx, user) => playerOf(ctx, user).hp < playerOf(ctx, user).maxHp,
  *effect(ctx, eff) {
    yield* runEvent(ctx, {
      kind: 'Recover',
      to: eff.target!,
      amount: 1,
      source: eff.source,
      card: eff.card,
      causeId: eff.id,
    })
  },
}
```

### 10.3 M2 / M3 注册示例(证明"只加注册项")

```ts
// 装备:坐骑是纯数据;连弩 / 仁王盾是修正技;八卦阵是触发技
{ name: 'dilu', type: 'equip', equip: { slot: 'horse_defensive', range: null, distance: +1, skills: [] }, target: { auto: 'self', … } }
{ id: 'equip.crossbow', type: 'modifier', locked: true, lord: false, modifiers: { useLimit: (ctx, owner, v, subject, card) => subject === owner && card.name === 'slash' ? UNLIMITED : v } }
{ id: 'equip.renwang_shield', type: 'modifier', locked: true, lord: false, modifiers: { nullifyEffect: (ctx, owner, v, eff) => v || (eff.target === owner && eff.card.name === 'slash' && colorOf(ctx, eff.card) === 'black') } }
{ id: 'equip.eight_diagram', type: 'trigger', timings: ['AskCard.before'], locked: false, priority: 0, triggerWhenDead: false,
  canTrigger: (ctx, ev, owner) => ev.player === owner && patternAccepts(ev.pattern, 'jink'),
  *effect(ctx, ev, owner) { const j = yield* runEvent(ctx, { kind: 'Judge', player: owner, reason: 'eight_diagram', pattern: { colors: ['red'], … }, card: null, matched: null, retrialBy: [] })
                            if (j.matched) ev.result = { responded: true, card: { name: 'jink', suit: 'none', number: 0, subcards: [], viewAs: 'equip.eight_diagram' } } } }
// 武将技能(M3)
{ id: 'mashu', type: 'modifier', locked: true, modifiers: { distanceFrom: (ctx, owner, v, from) => from === owner ? v - 1 : v } }
{ id: 'paoxiao', type: 'modifier', locked: true, modifiers: { useLimit: (ctx, owner, v, subject, card) => subject === owner && card.name === 'slash' ? UNLIMITED : v } }
{ id: 'kongcheng', type: 'modifier', locked: true, modifiers: { prohibitTarget: (ctx, owner, v, src, tgt, card) => v || (tgt === owner && handCount(ctx, owner) === 0 && (card.name === 'slash' || card.name === 'duel')) } }
{ id: 'yiji', type: 'trigger', timings: ['Damage.done'], times: (ctx, ev) => ev.amount, canTrigger: (ctx, ev, owner) => ev.to === owner, *effect(…) { /* peek 2 → chooseCards / choosePlayers 分配 */ } }
{ id: 'wusheng', type: 'viewAs', produces: ['slash'], cardCount: [1, 1], cardFilter: (ctx, o, card) => colorOf(ctx, card) === 'red', viewAs: (ctx, o, cards) => ({ name: 'slash', suit: spec(cards[0]).suit, number: spec(cards[0]).number, subcards: cards, viewAs: 'wusheng' }), … }
{ id: 'guicai', type: 'trigger', timings: ['Judge.cardShown'], canTrigger: (ctx, ev, owner) => handCount(ctx, owner) > 0,
  *effect(ctx, ev, owner) { const r = yield* ask(ctx, { kind: 'chooseCards', player: owner, candidates: handCandidates(ctx, owner), min: 0, max: 1, cancellable: true, … })
                            if (r.indices.length) yield* retrial(ctx, ev, handOf(ctx, owner)[r.indices[0]!]!, owner, false) } }
// 模式(M3):身份局 = 一个 ModeDef(setup 分身份 / 主公 +1 maxHp / 首回合主公;onDeath 奖惩;checkWinner;roleVisible)
```

### 10.4 扩展点与"不改引擎"的边界(诚实版)

| 新增内容                                 | 需要改的地方                                                           | 级别                      |
| ---------------------------------------- | ---------------------------------------------------------------------- | ------------------------- |
| 新牌 / 新装备 / 新武将 / 新技能 / 新模式 | 注册项                                                                 | 零改动                    |
| 新时机(如 `Slash.missed`)                | 内容包 `declare module` 合并到 `TimingEventMap` + 卡牌效果里 `stage()` | 零改动核心                |
| 新修正钩子                               | `declare module` 合并到 `ModifierHooks` + 内容代码里 `fold()`          | 零改动核心                |
| 新事件种类(Pindian / ChangeMaxHp)        | `GameEvent` 联合 + `TimingEventMap` + `events/index.ts` handler        | 加表项                    |
| 新 Request kind                          | `Request/Response` 联合 + `validate.ts` + `defaultResponse`            | 加表项(三处)              |
| 新区域(武将牌上的牌,风 / 火包)           | `Zone` 联合 + `zoneOf / assertCardInvariant / moveCards / view`        | 改核心(已知,标准版不需要) |

标准版 25 名武将 + 全部标准牌按上表只需前三行(已逐技能推演:护驾 / 激将走 `AskCard.before` 向他人 `askCard`;观星用 `arrange` + `reorderDrawPile`;反间 / 过河拆桥用盲位 `chooseCards`;遗计用 `times`;无双 / 铁骑用 `requiredResponses / responseCounts`;离间用 `CardUse.nullifiable = false`;连营 / 枭姬用 `CardsMove.after`)。

---

## 11. M1 模块划分与文件清单

### 11.1 文件

```
packages/engine/src/
  index.ts                  公开导出:Game, runGame, createRegistryBuilder, createStandardRegistry, defaultResponse, 全部类型
  core/types.ts             本设计的类型骨架(docs/engine-core-types.draft.ts)
  core/rng.ts               mulberry32 next / randomInt / shuffle
  core/state.ts             createInitialState, playerOf, playersFrom, nextAlive, orderTargets, eventById, distance, attackRange,
                            useLimit, usedInPlay, maxHandCards, usableCards, usableSkills, legalTargets, matchingCards, clearScopedFlags
  core/zones.ts             zoneOf, moveCards, ensureDrawPile, peekDrawPile, drawFromPile, reorderDrawPile, allCardsOf, assertCardInvariant
  core/flow.ts              Flow 工具:ask, askCard, 未消费生成器检测(detectUnconsumedFlows)
  core/trigger.ts           trigger, skillsOf
  core/modifiers.ts         fold
  core/registry.ts          createRegistryBuilder(校验、索引、contentHash)
  core/view.ts              viewFor, eventSummary, visibleTo
  core/validate.ts          validateResponse, defaultResponse
  core/hash.ts              canonicalJson, stateHash(cyrb53)
  core/engine.ts            Game 类(start / step / fromState / restore / snapshot / stateHash)、runEvent、stage、gameOver、错误类
  core/runner.ts            PlayerController 接口 + runGame()(唯一 async)
  events/index.ts           handlers 表
  events/game.ts            runGame 顶层循环、GameStart、Turn、Phase(含 judgePhase / drawPhase / playPhase / discardPhase)
  events/cards.ts           DrawCards、CardsMove、AskCard、CardUse、CardRespond、CardEffect、resolveNullification
  events/hp.ts              Damage、LoseHp、Recover、Dying、Death
  events/judge.ts           Judge、retrial
  cards/deck.standard.ts    108 张 DeckEntry(来自 docs/data/standard-deck.md §7 JSON)
  cards/pattern.ts          matchPattern、byName
  cards/basic.ts            slash / jink / peach
  generals/placeholder.ts   M1 无技能占位武将(4 血)
  modes/ffa.ts              M1 模式:最后存活者胜,无身份
  packages/standardM1.ts    ContentPackage { cards: [slash, jink, peach], generals: [placeholder], modes: [ffa] }
  testing/index.ts          对外导出的测试工具:ScriptedController、answer(game, partial)、buildState(overrides)、recordingSkill
packages/engine/test/
  rng.test.ts               种子可复现、分布粗检
  state.test.ts             JSON 往返、Infinity/undefined 检查、clearScopedFlags
  zones.test.ts             moveCards 原子性、不变量、ensureDrawPile 洗回、reorderDrawPile
  trigger.test.ts           假技能验证 7d:优先级桶 / 座位序 / 锁定技优先 / invokeSkill 选择 / times / declined / 重扫
  modifiers.test.ts         fold 折叠、距离 / 攻击范围 / useLimit / prohibitTarget
  validate.test.ts          每种 Request 的合法 / 非法应答 fuzz;'throw' 不前进、'default' 记录生效应答
  view.hidden.test.ts       视图不泄露隐藏 id;日志可见性分组
  basic-cards.test.ts       杀→闪、杀→伤害→濒死→桃(含同一人连续出桃、从回合玩家起询问)、濒死→死亡→结束,全部 g.step() 同步脚本
  turn.test.ts              六阶段顺序、摸牌 / 弃牌、skipPhases、Phase.before 取消、@turn/@phase 清理
  timings.snapshot.test.ts  记录型技能跑固定脚本,时机序列快照
  replay.test.ts            同种子两次 hash 相等;responses 回放 hash 相等;200 种子
  serialize-resume.test.ts  每个回合边界 snapshot → restore → 继续,与不中断一致
  flow-guard.test.ts        漏写 yield* 被 detectUnconsumedFlows 捕获
  simulation.test.ts        100 局随机 AI 无异常、不变量全程成立、maxTurns 内结束
packages/ai/src/randomController.ts     随机 AI(引擎外,(seed, player) 派生 RNG,从 Request 候选中随机选合法项)
tools/sim/src/main.ts                   pnpm sim --games N --seed S --players P:异常 / 回合数 / 不变量 / 每局 hash 统计
```

依赖方向:`core/types.ts` 不依赖实现;`events → core`;`cards / generals / modes → core + events`;`runner / testing → core`;`packages/ai → @sgs/engine` 公开 API。

### 11.2 出牌阶段(M1 最小实现)

```ts
function* playPhase(ctx: Ctx, p: PlayerId) {
  for (;;) {
    if (!playerOf(ctx, p).alive) break
    const r = yield* ask(ctx, { kind: 'play', player: p, usableCards: usableCards(ctx, p), usableSkills: usableSkills(ctx, p), reason: null, prompt: { key: 'play', args: {} } })
    if (r.action === 'end') break
    if (r.action === 'useCard') {
      const face = faceOf(ctx, r.card)
      yield* runEvent(ctx, { kind: 'CardUse', source: p, card: face, targets: r.targets, currentTarget: null, reason: 'play', againstId: null,
                             nullifiable: defaultNullifiable(ctx, face), responseCounts: {} })
    } else {                                                                           // M3:主动技 / 转化技
      const skill = ctx.registry.skill(r.skill)
      if (skill.type === 'active') yield* skill.effect(ctx, p, r.cards, r.targets)
      else if (skill.type === 'viewAs') { const face = skill.viewAs(ctx, p, r.cards, r.as!)!; yield* runEvent(ctx, { kind: 'CardUse', source: p, card: face, targets: r.targets, …, reason: 'play' }) }
    }
  }
}
```

M1 未注册的锦囊 / 装备仍在牌堆(保总牌数不变量与真实手牌分布),`usableCards` 把 `registry.card(name) === null` 或 `canUse === false` 的牌排除;随机 AI 会在弃牌阶段弃掉它们。

### 11.3 验收(M1)

- `pnpm test` 全绿;`simulation.test.ts` 100 局;`pnpm sim --games 10000 --players 5` 0 异常、不变量全程成立、每局在 `maxTurns` 内结束、同种子重跑 hash 一致。
- 两个随机 AI(`packages/ai`)通过 `runGame` 打完一局;`serialize-resume` 与 `replay` 测试通过。

### 11.4 Lint 与工程约束(引擎包)

- `no-restricted-globals: ['Date']`、`no-restricted-properties: [Math.random]`;`core/ events/ cards/` 下禁止 `async` / `Promise`(自定义 `no-restricted-syntax`),`runner.ts` 例外。
- `require-yield`(兜底"整个函数没 yield")+ 自定义 typed 规则 `sgs/flow-must-be-consumed`:返回类型别名为 `Flow` 的调用表达式必须是 `yield*` 的操作数、`return` 的操作数或变量初始值(约 40 行,利用 `projectService` 的类型信息)。
- 运行时 `detectUnconsumedFlows`(测试与模拟器打开)作为第二层网。
- `finally` 中出现 `yield` 的自定义规则(简单 AST 检查)。

---

## 12. 八个结算难点的逐条处理

### 12a 嵌套结算:杀 → 伤害 → 濒死 → 求桃 → 死亡 → 奖惩

```ts
// events/hp.ts
function* onDamage(ctx, ev: DamageEvent) {
  const victim = playerOf(ctx, ev.to)
  if (!victim.alive) {
    ev.cancelled = true
    return
  } // 已死亡者不再受伤、不进入濒死
  if (!(yield* stage(ctx, 'Damage.caused', ev))) return
  if (!(yield* stage(ctx, 'Damage.inflicted', ev))) return
  if (ev.amount <= 0) return // 被防止
  victim.hp -= ev.amount
  ctx.log({
    type: 'damage',
    data: { from: ev.from, to: ev.to, amount: ev.amount, nature: ev.nature },
    visibleTo: null,
    eventId: ev.id,
  })
  if (victim.hp <= 0) yield* runEvent(ctx, { kind: 'Dying', player: ev.to, damageId: ev.id })
  yield* stage(ctx, 'Damage.done', ev) // 奸雄 / 反馈 / 刚烈 / 遗计;不可取消
  yield* stage(ctx, 'Damage.after', ev)
}
function* onDying(ctx, ev: DyingEvent) {
  const victim = playerOf(ctx, ev.player)
  if (!(yield* stage(ctx, 'Dying.enter', ev))) return // 不屈 / 涅槃类在此把 hp 拉回 > 0
  if (victim.hp <= 0) {
    for (const p of playersFrom(ctx.state, anchor(ctx.state))) {
      // 从当前回合玩家起座位序(快照),轮到时再查存活
      if (!p.alive) continue
      while (victim.hp <= 0 && victim.alive) {
        // 同一玩家可连续出多张桃
        const r = yield* askCard(ctx, {
          player: p.id,
          pattern: byName('peach'),
          mode: 'use',
          targets: [victim.id],
          againstId: null,
          reasonId: ev.id,
          prompt: { key: 'ask.peach', args: { target: victim.id } },
        })
        if (!r.responded) break // askCard 内已完成 CardUse → CardEffect → Recover
      }
      if (victim.hp > 0) break
    }
  }
  yield* stage(ctx, 'Dying.after', ev)
  if (victim.hp <= 0 && victim.alive) {
    const dmg = ev.damageId === null ? null : eventById(ctx.state, ev.damageId)
    yield* runEvent(ctx, {
      kind: 'Death',
      player: victim.id,
      killer: dmg?.kind === 'Damage' ? dmg.from : null,
      damageId: ev.damageId,
    })
  }
}
function* onDeath(ctx, ev: DeathEvent) {
  yield* stage(ctx, 'Death.before', ev)
  const p = playerOf(ctx, ev.player)
  p.alive = false
  p.roleRevealed = true
  ctx.log({
    type: 'death',
    data: { player: p.id, role: p.role, killer: ev.killer },
    visibleTo: null,
    eventId: ev.id,
  })
  const mode = ctx.registry.mode(ctx.state.mode)
  const result = mode.checkWinner(ctx)
  if (result) gameOver(ctx, result) // 胜负先于奖惩
  yield* stage(ctx, 'Death.after', ev)
  yield* mode.onDeath(ctx, ev) // M3 身份局:反贼被杀者摸三张;主公杀忠弃全部
  yield* moveCards(
    ctx,
    allCardsOf(p).map((card) => ({ card, to: { kind: 'discard' }, reason: 'bury' })),
  )
}
```

- 求桃期间任何技能 / 事件(出桃触发的 `CardUse` 时机、救援的 `Recover.before`、急救的 `AskCard.before`)都在更深的生成器帧中自然发生。
- `AskCard.targets = [victim]` 优先于桃的 `target.auto: 'self'`。
- 回合玩家在自己回合死亡:`onTurn` 的阶段循环在下一阶段前 break,当前事件(如万箭)继续结算完。
- 濒死中再次受伤(M3 极少)会在更深一层再进入 `Dying`,内层求桃结束后外层 `while` 继续判断 hp;若需去重,在 `Dying.enter` 查栈上是否已有同玩家的 `Dying`(§15)。

### 12b 无懈可击链(任意深度 = 递归)

```ts
// events/cards.ts
function* resolveNullification(ctx, eff: CardEffectEvent): Flow<void> {
  for (;;) {
    let responded = false
    for (const p of playersFrom(ctx.state, anchor(ctx.state))) {
      // 从当前回合玩家起
      if (!p.alive) continue
      const r = yield* askCard(ctx, {
        player: p.id,
        pattern: byName('nullification'),
        mode: 'use',
        targets: [],
        againstId: eff.id,
        reasonId: eff.id,
        prompt: {
          key: 'ask.nullification',
          args: { card: eff.card.name, target: eff.target ?? -1 },
        },
      })
      if (r.responded) {
        responded = true
        break
      } // 无懈的 CardUse 已完整结算,结果体现在 eff.nullified
    }
    if (!responded || eff.nullified || !ctx.options.reopenNullification) return
    // 无懈被反无懈、原效果仍有效 ⇒ 重新开放一轮询问(QSanguosha / FreeKill 口径);选项关闭则只问一轮
  }
}
// cards/tricks.ts(M2)—— 无懈可击
export const nullification: CardDef = {
  name: 'nullification',
  type: 'trick',
  nullifiable: true,
  target: { min: 0, max: 0, auto: null, range: null, excludeSelf: false },
  canUse: () => false, // 只能响应
  *effect(ctx, eff) {
    const use = eventById(ctx.state, eff.useId!)
    const target =
      use?.kind === 'CardUse' && use.againstId !== null ? eventById(ctx.state, use.againstId) : null
    if (target?.kind === 'CardEffect') target.nullified = true // 针对的效果一定是栈上的祖先
  },
}
```

递归路径:锦囊 `CardEffect(A)` → `resolveNullification(A)` → X 使用无懈 → `CardUse(N1, againstId = A)` → 零目标 ⇒ `CardEffect(N1, target = null, nullifiable = true)` → `resolveNullification(N1)` → Y 使用无懈 → `CardEffect(N2)` → … 最深一层无人响应 → 最内层无懈的 `effect` 把它针对的效果 `nullified = true` → 逐层返回:被抵消的无懈不执行 `effect`,未被抵消的执行 → 奇偶性自然正确,没有任何深度相关代码。深度只受 `maxStackDepth` 限制。零目标牌恒产生一个 `target = null` 的 `CardEffect`,这是无懈 `effect` 得以执行的前提(修正底本的未定义点)。

### 12c 延时锦囊与改判

- 使用乐不思蜀:普通 `CardUse → CardEffect(target = X, delayed = false, nullifiable = false)`,`effect` 把牌 `moveCards` 到 X 的判定区(使用时不询问无懈,规则如此;`nullifiable` 在创建 `CardEffect` 时按类型与 `delayed` 填,底本"按 type 问无懈"的文字 / 代码不一致已消除)。
- 判定阶段:

```ts
function* judgePhase(ctx, p: PlayerId) {
  const cards = [...playerOf(ctx, p).judgeArea].reverse()                      // 快照,后放置先判定;本阶段新进入的牌不判
  for (const card of cards) {
    if (!playerOf(ctx, p).alive) break
    const z = zoneOf(ctx.state, card); if (z.kind !== 'judge' || z.player !== p) continue        // 已被移走(闪电转移 / 拆桥)
    const def = ctx.registry.card(spec(ctx, card).name)!
    yield* moveCards(ctx, [{ card, to: { kind: 'processing' }, reason: 'delayed_trick' }])
    yield* runEvent(ctx, { kind: 'CardEffect', useId: null, card: faceOf(ctx, card), source: null, target: p, delayed: true,
                           nullifiable: def.nullifiable, nullified: false, voided: false, responded: false, requiredResponses: 0 })
    if (zoneOf(ctx.state, card).kind === 'processing') yield* moveCards(ctx, [{ card, to: { kind: 'discard' }, reason: 'delayed_trick' }])   // 闪电转移走的不在
  }
}
// M2 乐不思蜀 / 闪电
*effect(ctx, eff) {                                                            // indulgence
  if (!eff.delayed) { yield* moveCards(ctx, [{ card: eff.card.subcards[0]!, to: { kind: 'judge', player: eff.target! }, reason: 'delayed_trick' }]); return }
  const j = yield* runEvent(ctx, { kind: 'Judge', player: eff.target!, reason: 'indulgence', pattern: { suits: ['heart'], … }, card: null, matched: null, retrialBy: [] })
  if (!j.matched) ctx.state.turn!.skipPhases.push('play')
}
*effect(ctx, eff) {                                                            // lightning
  if (!eff.delayed) { /* 入自己判定区 */ return }
  const j = yield* runEvent(ctx, { kind: 'Judge', …, reason: 'lightning', pattern: { suits: ['spade'], numberRange: [2, 9], … } })
  if (j.matched) yield* runEvent(ctx, { kind: 'Damage', from: null, to: eff.target!, amount: 3, nature: 'thunder', card: eff.card, causeId: eff.id })
  else yield* passLightning(ctx, eff)                                          // 移到下一名判定区无闪电且可成为目标者的判定区;找不到留处理区 → 弃牌堆
},
*onNullified(ctx, eff) { if (eff.delayed) yield* passLightning(ctx, eff) }     // 被无懈:不判定、照样传递(修正底本"直接弃掉"的错误)
// events/judge.ts
function* onJudge(ctx, ev: JudgeEvent) {
  yield* stage(ctx, 'Judge.before', ev)
  const [card] = yield* peekDrawPile(ctx, 1)                                   // 只保证牌堆够并返回顶牌 id,不移动(修正底本 drawFromPile 的双重移动)
  yield* moveCards(ctx, [{ card: card!, to: { kind: 'processing' }, reason: 'judge' }]); ev.card = card!
  yield* stage(ctx, 'Judge.cardShown', ev)                                     // 鬼才 / 司马懿在此 retrial()
  ev.matched = matchPattern(ctx.registry.spec(ev.card), ev.pattern)
  yield* stage(ctx, 'Judge.result', ev)                                        // 天妒 / 洛神在此把判定牌收入手牌
  yield* stage(ctx, 'Judge.after', ev)
  if (zoneOf(ctx.state, ev.card).kind === 'processing') yield* moveCards(ctx, [{ card: ev.card, to: { kind: 'discard' }, reason: 'judge' }])
}
/** 改判原子动作:新牌入处理区、旧判定牌入弃牌堆或改判者手牌;鬼才不走"打出"(避免 CardRespond 把新判定牌弃掉再搬回的假移动) */
export function* retrial(ctx, judge: JudgeEvent, newCard: CardId, by: PlayerId, takeOld: boolean): Flow<void> {
  const old = judge.card!
  yield* moveCards(ctx, [{ card: newCard, to: { kind: 'processing' }, reason: 'retrial' }])
  yield* moveCards(ctx, [{ card: old, to: takeOld ? { kind: 'hand', player: by } : { kind: 'discard' }, reason: 'retrial' }])
  judge.card = newCard; judge.retrialBy.push(by)
}
```

鬼才 = `TriggerSkill<'Judge.cardShown'>`:`canTrigger` 有手牌,`effect` 用 `chooseCards` 选一张后 `retrial()`——引擎零改动。八卦阵的判定同样走 `Judge` 事件,因此鬼才也能改八卦阵的判定。

### 12d 触发技时机与顺序

见 §6:优先级桶 → 从当前回合玩家起座位序 → 同玩家锁定技先、可选技由 `invokeSkill` 选 → `times()` 多次触发(遗计)→ 拒绝不再问 → 每次发动后重扫 → 事件取消即终止。锁定技不产生 Request(回放日志里也没有)。

### 12e 修正类技能 / 装备

见 §7 与 §10.3:攻击范围 = 武器基值 + `attackRange` 折叠;距离 = 座位距离 + 坐骑数据 + `distanceFrom / distanceTo`;出杀次数 = `useLimit`(连弩 / 咆哮 → `UNLIMITED`)且只统计 `reason === 'play'`;牌无效 = `nullifyEffect`(仁王盾,在 `CardEffect` 生效前查,目标仍可被选为目标——与规则"无效而非不能指定"一致);不能成为目标 = `prohibitTarget`;需要两张响应 = `requiredResponses`(无双)。装备进入装备区即生效(`skillsOf` 按 `equips` 现算)。

### 12f 多目标锦囊逐目标结算、单独无懈

`onCardUse` 对 `orderTargets(targets)`(从使用者起座位序,使用者是目标时第一)逐个 `runEvent(CardEffect)`;每个 `CardEffect` 自带 `nullifiable / nullified`,`resolveNullification` 以单个效果为单位询问 ⇒ 对第 2 个目标的无懈不影响第 3 个;某目标在轮到时已死亡则跳过,其后目标继续。万箭 / 南蛮 `target: { auto: 'allOthers' }` 由引擎填目标,Request 不要求玩家选;`CardUse.targeted` 时机(目标侧)允许流离在结算前转移目标。

### 12g 回合流程与跳过阶段

见 §3.3 `onTurn / onPhase`:六阶段顺序固定;`skipPhases` 是数据,任何技能 / 牌在该阶段开始前写入即可(乐在判定阶段写 `'play'`);`Phase.before` 时机取消 = 跳过(克己);`Phase.skipped` 时机供"跳过阶段时"类技能;`Phase.start` 取消 = 不执行正文与 `Phase.end`。阶段正文内的子事件各自可取消 / 可改(突袭取消 `DrawCards`、英姿改 `count`),不需要把正文做成"规则技"。额外回合由顶层循环的 `turnQueue` 驱动。

### 12h 中途存档 / 回放

见 §9:录像 = `Snapshot{base: null, responses: 全部}`;存档 = `Snapshot{base: 回合边界状态, responses: 本回合}`;恢复都是 `Game.restore` 的同步 `step`;联机重连只需重发 `pending`。M1 实现 `snapshot / restore / fromState` 与 `serialize-resume` 测试(成本很低,且它正是 M1 测试夹具 `buildState + Game.fromState` 的同一机制),M6 / M7 只加文件格式与传输。

---

## 13. 对底本的修订清单(评审项 → 处理)

| #   | 评审指出                                                                     | 定稿处理                                                                                                                       |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 事件对象引用 + 就地突变,state 不可恢复(致命)                                 | 事件间只用 `EventId`;`AskCard.result` 纯数据;日志只放快照;`stateHash` 不再需要"id 化"                                          |
| 2   | 全量回放是唯一恢复手段、弱版本门禁(致命)                                     | 回合边界快照 + 本回合应答;`Game.fromState`;`engineVersion / schemaVersion / contentHash` 门禁;额外回合由顶层循环驱动           |
| 3   | `canTrigger / ModifierHooks` 只拿 `state`,拿不到 registry                    | 所有钩子签名统一收 `ctx`;`PlayerState` 冗余 `kingdom / gender`                                                                 |
| 4   | `TriggerSkill.ev: GameEvent` 不按时机收窄                                    | `TimingEventMap` 派生 `Timing`;`TriggerSkill<T>` 自动收窄;内容包可 `declare module` 加时机                                     |
| 5   | 事件无扩展袋                                                                 | `EventBase.tags`;高频机制改标准字段:`responseCounts / requiredResponses / nullifiable / voided / responded`                    |
| 6   | `ViewAsSkill` 主动使用路径未定义                                             | `produces / cardCount / cardFilter / enabledAtPlay / enabledAtResponse`;`PlayRequest.usableSkills` 与 `AskCardResponse.viewAs` |
| 7   | 封闭的 `ModifierHooks`                                                       | `declare module` 可合并;`fold` 泛型化;新增 `ignoreDistance / extraTargets / requiredResponses`;`useLimit` 替代 `slashLimit`    |
| 8   | 牌堆位置语义、盲选、排序请求                                                 | `CardMove.position`、`reorderDrawPile`;`chooseCards` 盲位候选 + `indices`;新增 `arrange`                                       |
| 9   | flags 生命周期靠纪律                                                         | `@turn / @phase` 后缀自动清理(`flags / marks / counters`)                                                                      |
| 10  | 主公技 / 性别缺失                                                            | `SkillBase.lord`、`GeneralDef.gender`、`mode.lordSkillsEnabled`                                                                |
| 11  | 引擎内中文文案                                                               | `Prompt {key, args}`                                                                                                           |
| 12  | 无懈被反无懈后是否再开放                                                     | `reopenNullification` 选项(默认 true),`while` 循环实现                                                                         |
| 13  | 使用 vs 打出未分、零目标牌无 `CardEffect`、打出的杀会走 `effect`             | 新增 `CardRespond` 事件;零目标 ⇒ 一个 `target = null` 的 `CardEffect`;`mode: 'play'` 不产生效果                                |
| 14  | 延时锦囊使用时被问无懈;闪电被无懈后被弃掉                                    | `CardEffect.nullifiable` 按(类型, delayed)填;`CardDef.onNullified`                                                             |
| 15  | 鬼才打出牌被 `CardUse` 弃掉;`drawFromPile` 双重移动;判定区循环死循环         | `retrial()` 原子动作;`peekDrawPile` 不移动;`judgePhase` 对判定区快照迭代                                                       |
| 16  | `done` 只允许一次(遗计);priority 语义                                        | `times()`;priority 改为跨玩家桶;拒绝永久、发动后重扫                                                                           |
| 17  | 武器 `Math.max` 语义错;借刀 / 激将的杀误计次                                 | 武器范围为基值;坐骑为数据;只统计 `reason === 'play'`                                                                           |
| 18  | 目标顺序、`state.turn` 清理、额外回合入口                                    | `orderTargets` 从使用者起;`onTurn finally`;`turnQueue`                                                                         |
| 19  | 日志混合可见性;视图携带全量 log;`log data: ev`                               | 日志移出状态、按可见性分组、只下发增量、禁止放事件引用                                                                         |
| 20  | `require-yield` 抓不到漏写 `yield*`                                          | 自定义 typed-lint `flow-must-be-consumed` + 运行时 `detectUnconsumedFlows`                                                     |
| 21  | `finally` 断言掩盖原异常;非 GameOver 异常后生成器死亡无兜底                  | 异常在途不断言;`finally` 禁 `yield`;`broken` 状态 + 服务端回滚到回合边界快照;`maxStackDepth`                                   |
| 22  | 注册顺序作排序依据不稳定;`Infinity` 进状态                                   | `GeneralDef.skills` 声明序 + 槽序;`UNLIMITED`                                                                                  |
| 23  | 测试夹具:deckOrder / fromState / answer helper / 'default' 记录什么          | `GameConfig.fixedDeckOrder`、`Game.fromState`、`buildState`、`answer()`、`ScriptedController`;只记录生效应答                   |
| 24  | 对已死亡者造成伤害未定义;`Damage.done` 可取消无意义;`targets` 与 `auto` 冲突 | `onDamage` 开头取消;`done / after` 不可取消;`AskCard.targets` 优先                                                             |
| 25  | `Zone 'draw'`、`AskCard.result` 伪造事件                                     | `position`;`result: {responded, card}`                                                                                         |
| 26  | 校验两处真相                                                                 | `validateResponse` 与候选集共用函数;生成器内不再校验                                                                           |

---

## 14. 已知取舍与风险

1. **生成器纪律**:漏写 `yield*` 是最常见 bug;两层兜底(lint + 运行时)之外,`basic-cards.test.ts` 与模拟器对每条路径计数覆盖。
2. **存档只能从回合边界恢复**:回合中途的进度靠本回合应答回放(通常几十条)。若未来硬需求是"任意点直接快照",需要把核心改成显式续体——本设计明确不选。
3. **顺序询问而非并行**:无懈 / 求桃按座位序逐个问,联机体验比"同时响应"慢;缓解在引擎外(UI 的"本次结算自动不响应"开关、AI 立即应答);"无牌不问"进一步减少 Request 数但有时序泄露(§8.7)。
4. **AskCard 事件化**让每次响应多一层事件与两次时机扫描;registry 预建 timing → 技能索引,10000 局无头模拟预计足够;若 M3 后变慢,在 `trigger()` 里按玩家缓存候选。
5. **`CardId` 即明牌**:守则 + fuzz 测试保证不泄露;必要时种子置换 id(不改结构)。
6. **规则口径**:无懈再开放、桃园目标顺序、多次改判等存在多种裁定,已做成选项或在 §15 列出;引擎默认 QSanguosha / FreeKill 口径。
7. **新 Request kind / 新事件种类仍要改 `core/types.ts`**(加表项);标准版范围内已预留齐全,§10.4 诚实列明。
8. **M1 未注册的锦囊 / 装备在牌堆里**:随机 AI 会摸到不可用牌直接弃掉,M1 对局节奏与真实有偏差,不影响验收。
9. **牌堆耗尽**:弃牌堆洗入牌堆底(保持已有顶牌顺序);两者皆空判平局——比官方"洗弃牌堆"略保守,M2 前核对。

---

## 15. 未决问题

1. **无懈链再开放的默认值**:定稿默认 `reopenNullification = true`(QSanguosha / FreeKill);OL 口径为只问一轮。需产品决定并在 M2 单测锁住"无懈-无懈-无懈"三层。
2. **同一判定多次改判**:鬼才 `times` 暂为 1;另一名改判者改判后是否允许再次改判,M3 决定。
3. **跨玩家优先级例外**:标准版无需;若后续武将文本要求"先于其他技能",用 `priority` 桶或细分时机,二选一后固定。
4. **濒死重入去重**:濒死中再次受伤是否合并为同一次濒死,M3 决定(在 `Dying.enter` 查栈即可)。
5. **"置为"语义的修正钩子**(手牌上限固定值等):是否引入 `fixed*` 键与优先级,待出现需求再定。
6. **EX 牌**:108(含 EX)为默认;104 由 `setDeck(entries.filter(e => !e.extra?.ex))` 得到,是否暴露为对局选项由产品决定。
7. **"无牌不问"的时序泄露**与**`waitingFor` 暴露**:引擎接受;联机时是否在服务端做随机延迟遮蔽,M7 决定。
8. **`CardsMove.before` 是否允许修改 `moves`**(改变移动目的地的技能,标准版无):M1 只允许取消,改动待需求。
9. **平局判定的触发点**(牌堆耗尽、`maxTurns`):结果形状 `winners: []`,UI 如何呈现待 M5。
10. **服务端对 `broken` 对局的处理策略**(回滚后默认应答 vs 判平局):M7 决定,引擎只保证能回滚。
