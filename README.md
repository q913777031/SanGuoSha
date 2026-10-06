# 三国杀(个人学习项目)

三国杀玩法的卡牌游戏,TypeScript monorepo,手机浏览器可直接玩(PWA)。

> 本项目沿用三国杀官方卡名与技能文案,相关内容版权归游卡桌游所有;仅供个人学习自用,不公开发布、不商用。

- 执行计划:[docs/PLAN.md](docs/PLAN.md)
- 引擎设计:[docs/ENGINE_DESIGN.md](docs/ENGINE_DESIGN.md)

## 结构

| 目录              | 说明                          |
| ----------------- | ----------------------------- |
| `packages/engine` | 规则引擎,纯 TS,零 UI/IO 依赖  |
| `packages/ai`     | AI 控制器                     |
| `apps/web`        | React + Vite 客户端(手机优先) |
| `tools/sim`       | 无头模拟器,AI 对 AI 批量对局  |

## 常用命令

```sh
pnpm install
pnpm check        # typecheck + lint + format:check + test
pnpm test
pnpm sim          # 无头模拟
pnpm dev          # 启动网页客户端
```
