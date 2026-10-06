# 三国杀类卡牌游戏 · 执行计划书

## Context
仓库 `q913777031/SanGuoSha` 目前为空(仅 MIT LICENSE)。目标:做一款三国杀玩法的卡牌游戏,**跨平台、手机可直接玩**;MVP 为**单机 + AI 对战(标准身份局)**;沿用官方卡名/技能,**仅限个人学习自用,不公开发布、不商用**(游卡桌游版权)。

## 开源调研结论
| 项目 | 技术 | 许可 | 结论 |
|---|---|---|---|
| [FreeKill 新月杀](https://github.com/Qsgs-Fans/FreeKill) | Qt/QML + Lua,逻辑在 freekill-core | GPLv3 | 当前最活跃;**事件/触发技/询问模型**最值得参考 |
| [QSanguosha 太阳神](https://github.com/mogara/qsanguosha) | C++ Qt5 + Lua AI | GPLv3 + 素材 CC BY-NC-ND | 经典但老旧(Qt 5.3);参考技能分类、AI 打分思路 |
| [harry5z/Sanguosha](https://github.com/harry5z/Sanguosha) | Java Swing + Socket | — | 参考服务端/客户端拆分 |
| [SiliconSha](https://github.com/Oliver13211/SiliconSha) | React + Three.js | MIT | 唯一现代 Web 实现,参考前端交互 |

**原则**:只参考设计,**不拷贝 GPL 代码**进本仓库(本仓库是 MIT,混入 GPL 代码会造成许可冲突)。

## 技术选型(推荐:TypeScript Web + PWA)
- 手机浏览器打开即玩、可"添加到主屏幕";后续需要 APK 用 Capacitor 打包,同一份代码。
- 备选 Avalonia(C#,贴合你的 .NET 技能,也支持 Android/iOS/WASM),但移动端调试和包体成本高于 Web,故不选。

| 层 | 选型 |
|---|---|
| 仓库结构 | pnpm workspaces monorepo |
| 规则引擎 `packages/engine` | 纯 TS,零 UI/零 IO 依赖,可在 Node 无头运行 |
| AI `packages/ai` | 规则启发式 + 打分(参考太阳神 AI 思路) |
| 客户端 `apps/web` | React + Vite + Zustand,CSS/Framer Motion 动画,vite-plugin-pwa |
| 测试 | Vitest(单元/模拟)、Playwright(手机视口 E2E,用预装 Chromium) |
| 联机(后期) | Node + WebSocket,服务端权威,复用 engine |

## 引擎核心设计(决定成败的部分)
1. **状态与确定性**:`GameState` 纯数据可序列化;随机数用**带种子 RNG**;同种子+同操作序列 ⇒ 同结果(录像/回放/联机校验的基础)。
2. **事件驱动结算**:一切行为是 `GameEvent`(使用牌、造成伤害、回复、摸牌、判定、阶段开始…),每个事件有多个**时机点**(如 伤害:造成前/受到前/造成后/受到后),技能以**触发技**挂在时机点上(参考 FreeKill 的 GameEvent + TriggerSkill)。事件可嵌套形成**结算栈**。
3. **询问协议(唯一的交互出口)**:引擎需要玩家决策时发出 `Request`(出牌/响应闪/选目标/选牌/是否发动技能),由 `PlayerController` 接口异步应答;人类 UI、AI、远程玩家都是同一接口的实现 → 单机/联机零改动切换。
4. **信息隐藏**:引擎向控制器只下发该玩家视角的 `PlayerView`(手牌、身份按规则遮蔽),避免 AI/客户端"作弊",也为联机铺路。
5. **数据驱动内容**:卡牌、武将、技能以声明式定义 + 少量钩子函数注册到 registry,新增武将不改引擎。
6. **不变量**:总牌数恒为 108(手牌+装备+判定区+牌堆+弃牌堆+处理区),每次事件后断言。

## 目录(新建)
```
packages/engine/src/{core,events,cards,generals,modes,rng}
packages/ai/src
apps/web/src/{pages,components,store,assets}
tools/sim        # 无头 AI 对局批量模拟
```

## 里程碑
| # | 内容 | 验收 |
|---|---|---|
| M0 | monorepo 脚手架、lint/format、Vitest、CI(GitHub Actions) | `pnpm test` 通过,CI 绿 |
| M1 | 引擎骨架:状态、牌堆洗/摸/弃、回合六阶段、事件/时机/结算栈、询问协议;基本牌 杀/闪/桃(含濒死求桃) | 两个随机 AI 能打完一局 |
| M2 | 锦囊全套(含**无懈可击链**、延时锦囊 乐不思蜀/闪电 判定)、装备(武器攻击范围与特效、八卦阵/仁王盾、±1 马) | 每张牌至少一个单测 |
| M3 | 标准身份局(主/忠/反/内,主公技,胜负判定,5/8 人)、武将:先 8 名验证框架,再补齐标准版 25 名 | 每个技能单测;无头模拟 1 万局无异常、不变量不破 |
| M4 | AI:出牌价值打分、目标选择、基于行为的身份推断 | AI 胜率显著高于随机 AI |
| M5 | 手机优先 UI:横屏布局、手牌扇形、点选目标、技能按钮、出牌/响应倒计时、日志面板;PWA | Playwright 在 iPhone/Android 视口完整打完一局 |
| M6 | 打磨:音效、录像回放(种子+操作序列)、设置、新手提示 | 回放与原局逐步一致 |
| M7(后期) | 联机:Node WS 服务端权威、房间、断线重连;可选 Capacitor 打包 APK | 两台手机联机打完一局 |

## 最坏情况 / 易踩坑
1. 结算时机设计不当(如技能触发顺序、无懈链、濒死嵌套)→ 后期每加一个武将都要改引擎。M1 必须把事件/时机/结算栈定死并用测试锁住。
2. 引擎里直接写 UI/AI 逻辑 → 联机时重写。坚持"引擎只通过 Request 交互"。
3. 误拷 GPL 代码 → 许可冲突;官方素材 → 仓库保持 private、不公开发布。

## 验证方式
- `pnpm -r test`:卡牌/技能单测,每个用例固定种子。
- `pnpm sim --games 10000 --players 5`:AI 对 AI 无头模拟,期望 0 异常、108 张不变量全程成立、对局全部在回合上限内结束。
- `pnpm --filter web dev` + Playwright 移动视口脚本:完整打完一局,截图检查布局无溢出。

## 待你确认
- 仓库可见性:官方素材需保持 **private**,当前若为 public 请改为 private。
- 卡面美术:先用纯文字/色块卡面,后续再定素材来源。
