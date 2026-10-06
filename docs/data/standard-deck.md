# 三国杀 · 标准版游戏牌堆数据

> 适用范围：**标准版（2009 年发行、2011/2012 年新包装重印）的游戏牌**，即"界限突破前的标准版"，**不含军争篇**，不含武将牌 / 身份牌 / 体力牌。
> 本文只做数据，不含引擎代码。所有数据均由脚本从四个独立来源逐张比对后生成（见 [§3 取证来源与方法](#3-取证来源与方法)）。
> 生成日期：2026-10-06。

---

## 1. 结论：总张数与分类小计

**结论：标准版游戏牌 = 104 张基础牌 + 4 张 EX 牌 = 108 张。本项目采用 108 张（含 EX），EX 牌在数据中以 `extra.ex: true` 标记，引擎可按配置剔除以得到 104 张。**

| 分类           | 子类              | 108 张（含 EX，**采用**） | 104 张（不含 EX） | 说明                                                                                                                                         |
| -------------- | ----------------- | ------------------------: | ----------------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 基本牌         | 杀                |                        30 |                30 | ♠7 ♥3 ♣14 ♦6                                                                                                                                 |
| 基本牌         | 闪                |                        15 |                15 | ♥3 ♦12                                                                                                                                       |
| 基本牌         | 桃                |                         8 |                 8 | ♥7 ♦1                                                                                                                                        |
| **基本牌小计** |                   |                    **53** |            **53** |                                                                                                                                              |
| 锦囊牌         | 即时锦囊          |                        31 |                30 | EX：♦Q 无懈可击                                                                                                                              |
| 锦囊牌         | 延时锦囊          |                         5 |                 4 | EX：♥Q 闪电                                                                                                                                  |
| **锦囊牌小计** |                   |                    **36** |            **34** | 过河拆桥 6、顺手牵羊 5、无中生有 4、无懈可击 4(3)、决斗 3、南蛮入侵 3、乐不思蜀 3、借刀杀人 2、五谷丰登 2、闪电 2(1)、万箭齐发 1、桃园结义 1 |
| 装备牌         | 武器              |                        10 |                 9 | EX：♠2 寒冰剑                                                                                                                                |
| 装备牌         | 防具              |                         3 |                 2 | EX：♣2 仁王盾                                                                                                                                |
| 装备牌         | 坐骑 −1（进攻马） |                         3 |                 3 | 赤兔、大宛、紫骍                                                                                                                             |
| 装备牌         | 坐骑 +1（防御马） |                         3 |                 3 | 的卢、绝影、爪黄飞电                                                                                                                         |
| **装备牌小计** |                   |                    **19** |            **17** |                                                                                                                                              |
| **合计**       |                   |                   **108** |           **104** |                                                                                                                                              |

结构性校验：不含 EX 的 104 张恰好是 **4 种花色 × 13 个点数 × 每格 2 张**（脚本已验证 52 个花色点数格每格恰为 2 张）；4 张 EX 牌各占用 ♠2、♣2、♥Q、♦Q 一格，使这四格变为 3 张。这与三国杀 Wiki"标准版游戏牌列表"按花色点数排布、另设"EX 2 / EX Q"格的呈现方式一致。

---

## 2. 到底是 104 还是 108？各来源陈述与采用理由

### 2.1 各来源的说法

| 来源                                            | 说法                                                                                                             | 链接                                                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三国杀 Wiki（fandom）"三国杀游戏卡牌"           | "标准版中共有 108 张游戏牌，其中包括 4 张 EX 牌。基本牌 53 张（杀 30、闪 15、桃 8），锦囊牌 36 张，装备牌 19 张" | <https://sanguosha.fandom.com/zh/wiki/三国杀游戏卡牌>                                                                                               |
| 三国杀 Wiki（fandom）"标准版游戏牌列表"         | 按花色 × 点数（A–K）列表，另设 EX 2 / EX Q 格                                                                    | <https://sanguosha.fandom.com/zh/wiki/标准版游戏牌列表>                                                                                             |
| 三国杀 BWIKI "标准包卡牌"（经 GitHub 逐张转录） | "标准包 108 张，含 4 张 EX"；逐张表为 104 张 + EX 4 张（♥Q 闪电、♦Q 无懈可击、♠2 寒冰剑、♣2 仁王盾）             | <https://wiki.biligame.com/sgs/标准包卡牌>，转录件 <https://github.com/wangdingwen163/sanguosha-numerical-breakdown/blob/main/scripts/deck_data.py> |
| 维基百科"三国杀标准版"                          | 基本牌 53 / 锦囊 36 / 装备 19（= 108）；并记载推广版 EX ♦Q 原为【银月枪】，标准版发行时改为【无懈可击】          | <https://zh.wikipedia.org/zh-hans/三國殺標準版>                                                                                                     |
| 百度知道 / 喜马拉雅问答"标准版与 EX 牌"         | "标准版包含 104 张游戏牌加 4 张 EX 游戏牌"；EX = 黑桃 2 寒冰剑、梅花 2 仁王盾、方块 Q 无懈可击、红桃 Q 闪电      | <https://zhidao.baidu.com/question/440488216.html>，<https://m.ximalaya.com/ask/q1890987>                                                           |
| blog.shengbin.me "三国杀卡牌数量"               | 标准 104 + EX 4 = 108                                                                                            | <https://blog.shengbin.me/posts/number-of-cards-in-sanguosha>                                                                                       |
| FreeKill（freekill-core）`standard_cards` 包    | 单个包 108 张（EX 四张直接混入）                                                                                 | <https://github.com/Qsgs-Fans/freekill-core/blob/master/standard_cards/pkg/init.lua>                                                                |
| QSanguosha-v2（太阳神三国杀）                   | `standard_cards` 104 张 + 独立 `standard_ex_cards` 包 4 张                                                       | <https://github.com/Mogara/QSanguosha-v2/blob/master/src/package/standard-cards.cpp>                                                                |
| harry5z/Sanguosha（Java）                       | `STANDARD` 牌堆 103 张（缺雌雄双股剑，见 §9）+ `EX` 包 4 张                                                      | <https://github.com/harry5z/Sanguosha/blob/master/src/core/Deck.java>                                                                               |
| 18183 "三国杀标准版牌明细 最全 108 张牌明细"    | 标题称 108 张；搜索摘要中称"装备牌 18 张"（与 19/17 均不符）                                                     | <https://www.18183.com/gonglue/202207/4044017.html>                                                                                                 |

### 2.2 差异归纳

1. **"104" 与 "108" 并不矛盾**：所有来源都指同一套牌，差别只在是否把随盒附赠的 4 张 EX 牌计入。实体标准版盒内 4 张 EX 牌带有"EX"角标，官方说明为"可按相应花色替换/混入使用"；三国杀 OL、移动版以及所有开源引擎默认都把这 4 张混入牌堆。
2. **EX 牌的历史差异**：2008 年推广版的 EX ♦Q 是【银月枪】；2009 年标准版发行时改为【无懈可击】，之后 2011/2012 年新包装重印只改了说明书、牌面描述与牌背图案，未改变牌堆构成。本文档以 2009 年及以后的标准版为准，EX ♦Q = 无懈可击。
3. **界限突破（2014 年起）**在标准版基础上新增了装备牌【木牛流马】等，不在本文范围。
4. **18183 的"装备牌 18 张"**与其它所有来源（含 EX 19 张 / 不含 EX 17 张）不符，且该页本环境无法直接访问、只有搜索摘要，判断为该文统计口径错误（疑似只计入寒冰剑与仁王盾之一），**不采用**。
5. 搜索摘要里出现的"闪：红桃 3 张、方块 15 张"是摘要笔误（方块应为 12 张，合计 15 张），四个逐张来源均为 ♥3 + ♦12。

### 2.3 采用版本及理由

采用 **108 张（104 + 4 EX 全部纳入）**，并给每张 EX 牌打 `extra.ex: true` 标记：

- 与实体盒内物、三国杀 OL / 移动版及 FreeKill、QSanguosha-v2、harry5z 三个开源引擎的默认牌堆一致；
- 与 `docs/PLAN.md` 中"总牌数恒为 108"的引擎不变量一致；
- 带标记后，引擎只需在建堆时过滤 `extra.ex` 即可得到纯 104 张的"原教旨"牌堆，两种玩法都能覆盖。

---

## 3. 取证来源与方法

### 3.1 逐张比对的四个一手来源

| 编号 | 来源                                                                                  | 版本             | 本地核对文件                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | **FreeKill / freekill-core**（Qsgs-Fans，GPL-3.0）`standard_cards` 包                 | commit `c194416` | `standard_cards/pkg/init.lua`（`addCardSpec` 列表、`attack_range`、`sub_type`）；中文名取自 `standard_cards/i18n/zh_CN.lua`                                                                                                      |
| S2   | **QSanguosha-v2**（Mogara，太阳神三国杀经典版，GPL-3.0）                              | commit `e876885` | `src/package/standard-cards.cpp` 的 `StandardCardPackage` 与 `StandardExCardPackage` 构造函数；缺省花色/点数取自 `src/package/standard-equips.h`、`src/package/standard.h`；武器范围取自各武器构造函数 `Weapon(suit, number, N)` |
| S3   | **harry5z/Sanguosha**（Java）                                                         | commit `7b77454` | `src/core/Deck.java`（`initOriginal()` + `initEX()`）；武器范围取自 `src/cards/equipments/weapons/*.java` 的 `super(range, …)`                                                                                                   |
| S4   | **三国杀 BWIKI "标准包卡牌"逐张转录**（wangdingwen163/sanguosha-numerical-breakdown） | 2026 年主分支    | `scripts/deck_data.py` 的 `STANDARD_DECK`（按花色 × 点数两张）、`STANDARD_EX`、`WEAPON_RANGE`（后者转录自三国杀攻略 Wiki "卡牌列表"）                                                                                            |

链接：
S1 <https://github.com/Qsgs-Fans/freekill-core/blob/master/standard_cards/pkg/init.lua> ·
S2 <https://github.com/Mogara/QSanguosha-v2/blob/master/src/package/standard-cards.cpp> ·
S3 <https://github.com/harry5z/Sanguosha/blob/master/src/core/Deck.java> ·
S4 <https://github.com/wangdingwen163/sanguosha-numerical-breakdown/blob/main/scripts/deck_data.py>（原始页 <https://wiki.biligame.com/sgs/标准包卡牌>）

**注意：Mogara/QSanguosha 的 `master` 分支已是国战版实现**，其 "standard" 牌包含火杀、雷杀、铁索连环、火攻、白银狮子等军争牌，**不是**标准版牌堆，本文未采用。经典标准版在 `QSanguosha-v2` 仓库。

### 3.2 比对方法

用脚本分别解析 S1–S4 的源文件，得到四个 `(牌 id, 花色, 点数)` 多重集合，逐项比较张数，再由 S1 生成 §4 表格与 §7 JSON。结果：

- S1、S2、S4 三者 **108 张完全一致**（含 EX）；
- S3 为 107 张：缺【雌雄双股剑 ♠2】（源码中该行被注释掉、类未实现，属实现缺口而非数据分歧），其余 107 张与另三者一致；
- 武器攻击范围：S1、S2、S3、S4 四者对 9 种武器完全一致（雌雄双股剑为 S1、S2、S4 三者一致）。

### 3.3 取证等级定义

| 等级               | 含义                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| 已核对（N 源一致） | 该张牌的（名称、花色、点数、类别、武器范围）在 N 个一手来源中一致，N ≥ 2 |
| 单一来源           | 仅一个一手来源给出                                                       |
| 存疑               | 来源之间存在冲突，或无一手来源                                           |

### 3.4 本次取证的环境限制（如实说明）

本会话的网络出口代理拦截了 fandom、维基百科、百度百科、BWIKI、知乎、18183、豆瓣等站点的直接访问，这些站点的内容只能通过搜索引擎摘要获取，因此 §2 中它们只用于"总数 / EX 组成"这类汇总陈述，**逐张花色点数以 S1–S4 四个可完整读取的 GitHub 文件为准**。S4 是对 BWIKI 页面的第三方逐张转录，并非 BWIKI 原页；建议后续有人工条件时对照 BWIKI 或实体卡再抽查一次（预期无差异，因 S4 与两个独立引擎的 108 张完全一致）。

---

## 4. 逐张列表（108 张）

花色：`spade`=黑桃 ♠，`heart`=红桃 ♥，`club`=梅花 ♣，`diamond`=方块 ♦；点数 1–13（1=A，11=J，12=Q，13=K）。

| 名称       | 英文 id            | 类别        | 花色      | 点数 | 备注                      | 取证等级           |
| ---------- | ------------------ | ----------- | --------- | ---: | ------------------------- | ------------------ |
| 杀         | `slash`            | 基本        | spade ♠   |    7 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | spade ♠   |    8 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | spade ♠   |    8 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | spade ♠   |    9 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | spade ♠   |    9 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | spade ♠   |   10 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | spade ♠   |   10 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | heart ♥   |   10 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | heart ♥   |   10 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | heart ♥   |   11 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |    2 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |    3 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |    4 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |    5 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |    6 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |    7 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |    8 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |    8 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |    9 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |    9 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |   10 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |   10 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |   11 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | club ♣    |   11 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | diamond ♦ |    6 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | diamond ♦ |    7 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | diamond ♦ |    8 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | diamond ♦ |    9 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | diamond ♦ |   10 |                           | 已核对（4 源一致） |
| 杀         | `slash`            | 基本        | diamond ♦ |   13 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | heart ♥   |    2 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | heart ♥   |    2 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | heart ♥   |   13 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |    2 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |    2 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |    3 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |    4 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |    5 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |    6 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |    7 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |    8 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |    9 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |   10 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |   11 |                           | 已核对（4 源一致） |
| 闪         | `jink`             | 基本        | diamond ♦ |   11 |                           | 已核对（4 源一致） |
| 桃         | `peach`            | 基本        | heart ♥   |    3 |                           | 已核对（4 源一致） |
| 桃         | `peach`            | 基本        | heart ♥   |    4 |                           | 已核对（4 源一致） |
| 桃         | `peach`            | 基本        | heart ♥   |    6 |                           | 已核对（4 源一致） |
| 桃         | `peach`            | 基本        | heart ♥   |    7 |                           | 已核对（4 源一致） |
| 桃         | `peach`            | 基本        | heart ♥   |    8 |                           | 已核对（4 源一致） |
| 桃         | `peach`            | 基本        | heart ♥   |    9 |                           | 已核对（4 源一致） |
| 桃         | `peach`            | 基本        | heart ♥   |   12 |                           | 已核对（4 源一致） |
| 桃         | `peach`            | 基本        | diamond ♦ |   12 |                           | 已核对（4 源一致） |
| 过河拆桥   | `dismantlement`    | 锦囊-即时   | spade ♠   |    3 |                           | 已核对（4 源一致） |
| 过河拆桥   | `dismantlement`    | 锦囊-即时   | spade ♠   |    4 |                           | 已核对（4 源一致） |
| 过河拆桥   | `dismantlement`    | 锦囊-即时   | spade ♠   |   12 |                           | 已核对（4 源一致） |
| 过河拆桥   | `dismantlement`    | 锦囊-即时   | heart ♥   |   12 |                           | 已核对（4 源一致） |
| 过河拆桥   | `dismantlement`    | 锦囊-即时   | club ♣    |    3 |                           | 已核对（4 源一致） |
| 过河拆桥   | `dismantlement`    | 锦囊-即时   | club ♣    |    4 |                           | 已核对（4 源一致） |
| 顺手牵羊   | `snatch`           | 锦囊-即时   | spade ♠   |    3 |                           | 已核对（4 源一致） |
| 顺手牵羊   | `snatch`           | 锦囊-即时   | spade ♠   |    4 |                           | 已核对（4 源一致） |
| 顺手牵羊   | `snatch`           | 锦囊-即时   | spade ♠   |   11 |                           | 已核对（4 源一致） |
| 顺手牵羊   | `snatch`           | 锦囊-即时   | diamond ♦ |    3 |                           | 已核对（4 源一致） |
| 顺手牵羊   | `snatch`           | 锦囊-即时   | diamond ♦ |    4 |                           | 已核对（4 源一致） |
| 决斗       | `duel`             | 锦囊-即时   | spade ♠   |    1 |                           | 已核对（4 源一致） |
| 决斗       | `duel`             | 锦囊-即时   | club ♣    |    1 |                           | 已核对（4 源一致） |
| 决斗       | `duel`             | 锦囊-即时   | diamond ♦ |    1 |                           | 已核对（4 源一致） |
| 借刀杀人   | `collateral`       | 锦囊-即时   | club ♣    |   12 |                           | 已核对（4 源一致） |
| 借刀杀人   | `collateral`       | 锦囊-即时   | club ♣    |   13 |                           | 已核对（4 源一致） |
| 无中生有   | `ex_nihilo`        | 锦囊-即时   | heart ♥   |    7 |                           | 已核对（4 源一致） |
| 无中生有   | `ex_nihilo`        | 锦囊-即时   | heart ♥   |    8 |                           | 已核对（4 源一致） |
| 无中生有   | `ex_nihilo`        | 锦囊-即时   | heart ♥   |    9 |                           | 已核对（4 源一致） |
| 无中生有   | `ex_nihilo`        | 锦囊-即时   | heart ♥   |   11 |                           | 已核对（4 源一致） |
| 无懈可击   | `nullification`    | 锦囊-即时   | spade ♠   |   11 |                           | 已核对（4 源一致） |
| 无懈可击   | `nullification`    | 锦囊-即时   | club ♣    |   12 |                           | 已核对（4 源一致） |
| 无懈可击   | `nullification`    | 锦囊-即时   | club ♣    |   13 |                           | 已核对（4 源一致） |
| 无懈可击   | `nullification`    | 锦囊-即时   | diamond ♦ |   12 | EX 牌                     | 已核对（4 源一致） |
| 南蛮入侵   | `savage_assault`   | 锦囊-即时   | spade ♠   |    7 |                           | 已核对（4 源一致） |
| 南蛮入侵   | `savage_assault`   | 锦囊-即时   | spade ♠   |   13 |                           | 已核对（4 源一致） |
| 南蛮入侵   | `savage_assault`   | 锦囊-即时   | club ♣    |    7 |                           | 已核对（4 源一致） |
| 万箭齐发   | `archery_attack`   | 锦囊-即时   | heart ♥   |    1 |                           | 已核对（4 源一致） |
| 桃园结义   | `peach_garden`     | 锦囊-即时   | heart ♥   |    1 |                           | 已核对（4 源一致） |
| 五谷丰登   | `amazing_grace`    | 锦囊-即时   | heart ♥   |    3 |                           | 已核对（4 源一致） |
| 五谷丰登   | `amazing_grace`    | 锦囊-即时   | heart ♥   |    4 |                           | 已核对（4 源一致） |
| 乐不思蜀   | `indulgence`       | 锦囊-延时   | spade ♠   |    6 | 延时锦囊（判定区）        | 已核对（4 源一致） |
| 乐不思蜀   | `indulgence`       | 锦囊-延时   | heart ♥   |    6 | 延时锦囊（判定区）        | 已核对（4 源一致） |
| 乐不思蜀   | `indulgence`       | 锦囊-延时   | club ♣    |    6 | 延时锦囊（判定区）        | 已核对（4 源一致） |
| 闪电       | `lightning`        | 锦囊-延时   | spade ♠   |    1 | 延时锦囊（判定区）        | 已核对（4 源一致） |
| 闪电       | `lightning`        | 锦囊-延时   | heart ♥   |   12 | 延时锦囊（判定区）；EX 牌 | 已核对（4 源一致） |
| 诸葛连弩   | `crossbow`         | 装备-武器   | club ♣    |    1 | 攻击范围 1                | 已核对（4 源一致） |
| 诸葛连弩   | `crossbow`         | 装备-武器   | diamond ♦ |    1 | 攻击范围 1                | 已核对（4 源一致） |
| 青釭剑     | `qinggang_sword`   | 装备-武器   | spade ♠   |    6 | 攻击范围 2                | 已核对（4 源一致） |
| 寒冰剑     | `ice_sword`        | 装备-武器   | spade ♠   |    2 | 攻击范围 2；EX 牌         | 已核对（4 源一致） |
| 雌雄双股剑 | `double_swords`    | 装备-武器   | spade ♠   |    2 | 攻击范围 2                | 已核对（3 源一致） |
| 青龙偃月刀 | `blade`            | 装备-武器   | spade ♠   |    5 | 攻击范围 3                | 已核对（4 源一致） |
| 丈八蛇矛   | `spear`            | 装备-武器   | spade ♠   |   12 | 攻击范围 3                | 已核对（4 源一致） |
| 贯石斧     | `axe`              | 装备-武器   | diamond ♦ |    5 | 攻击范围 3                | 已核对（4 源一致） |
| 方天画戟   | `halberd`          | 装备-武器   | diamond ♦ |   12 | 攻击范围 4                | 已核对（4 源一致） |
| 麒麟弓     | `kylin_bow`        | 装备-武器   | heart ♥   |    5 | 攻击范围 5                | 已核对（4 源一致） |
| 八卦阵     | `eight_diagram`    | 装备-防具   | spade ♠   |    2 |                           | 已核对（4 源一致） |
| 八卦阵     | `eight_diagram`    | 装备-防具   | club ♣    |    2 |                           | 已核对（4 源一致） |
| 仁王盾     | `renwang_shield`   | 装备-防具   | club ♣    |    2 | EX 牌                     | 已核对（4 源一致） |
| 赤兔       | `chitu`            | 装备-坐骑-1 | heart ♥   |    5 | -1 马（进攻马）           | 已核对（4 源一致） |
| 大宛       | `dayuan`           | 装备-坐骑-1 | spade ♠   |   13 | -1 马（进攻马）           | 已核对（4 源一致） |
| 紫骍       | `zixing`           | 装备-坐骑-1 | diamond ♦ |   13 | -1 马（进攻马）           | 已核对（4 源一致） |
| 的卢       | `dilu`             | 装备-坐骑+1 | club ♣    |    5 | +1 马（防御马）           | 已核对（4 源一致） |
| 绝影       | `jueying`          | 装备-坐骑+1 | spade ♠   |    5 | +1 马（防御马）           | 已核对（4 源一致） |
| 爪黄飞电   | `zhuahuangfeidian` | 装备-坐骑+1 | heart ♥   |   13 | +1 马（防御马）           | 已核对（4 源一致） |

---

## 5. 按牌名汇总

| 名称       | 英文 id            | 类别         |  张数（含 EX） | 花色点数                                                                                               | 备注              |
| ---------- | ------------------ | ------------ | -------------: | ------------------------------------------------------------------------------------------------------ | ----------------- |
| 杀         | `slash`            | 基本         |             30 | ♠7 ♠8 ♠8 ♠9 ♠9 ♠10 ♠10 · ♥10 ♥10 ♥J · ♣2 ♣3 ♣4 ♣5 ♣6 ♣7 ♣8 ♣8 ♣9 ♣9 ♣10 ♣10 ♣J ♣J · ♦6 ♦7 ♦8 ♦9 ♦10 ♦K | 黑 21 / 红 9      |
| 闪         | `jink`             | 基本         |             15 | ♥2 ♥2 ♥K · ♦2 ♦2 ♦3 ♦4 ♦5 ♦6 ♦7 ♦8 ♦9 ♦10 ♦J ♦J                                                        | 全部红色          |
| 桃         | `peach`            | 基本         |              8 | ♥3 ♥4 ♥6 ♥7 ♥8 ♥9 ♥Q · ♦Q                                                                              | 全部红色          |
| 过河拆桥   | `dismantlement`    | 锦囊-即时    |              6 | ♠3 ♠4 ♠Q · ♥Q · ♣3 ♣4                                                                                  |                   |
| 顺手牵羊   | `snatch`           | 锦囊-即时    |              5 | ♠3 ♠4 ♠J · ♦3 ♦4                                                                                       | 距离 1            |
| 决斗       | `duel`             | 锦囊-即时    |              3 | ♠A · ♣A · ♦A                                                                                           |                   |
| 借刀杀人   | `collateral`       | 锦囊-即时    |              2 | ♣Q ♣K                                                                                                  |                   |
| 无中生有   | `ex_nihilo`        | 锦囊-即时    |              4 | ♥7 ♥8 ♥9 ♥J                                                                                            |                   |
| 无懈可击   | `nullification`    | 锦囊-即时    | 4（不含 EX 3） | ♠J · ♣Q ♣K · ♦Q(EX)                                                                                    |                   |
| 南蛮入侵   | `savage_assault`   | 锦囊-即时    |              3 | ♠7 ♠K · ♣7                                                                                             | 群体              |
| 万箭齐发   | `archery_attack`   | 锦囊-即时    |              1 | ♥A                                                                                                     | 群体              |
| 桃园结义   | `peach_garden`     | 锦囊-即时    |              1 | ♥A                                                                                                     | 群体              |
| 五谷丰登   | `amazing_grace`    | 锦囊-即时    |              2 | ♥3 ♥4                                                                                                  | 群体              |
| 乐不思蜀   | `indulgence`       | 锦囊-延时    |              3 | ♠6 · ♥6 · ♣6                                                                                           | 判定非 ♥ 则生效   |
| 闪电       | `lightning`        | 锦囊-延时    | 2（不含 EX 1） | ♠A · ♥Q(EX)                                                                                            | 判定 ♠2–♠9 则生效 |
| 诸葛连弩   | `crossbow`         | 装备-武器    |              2 | ♣A · ♦A                                                                                                | 攻击范围 1        |
| 青釭剑     | `qinggang_sword`   | 装备-武器    |              1 | ♠6                                                                                                     | 攻击范围 2        |
| 寒冰剑     | `ice_sword`        | 装备-武器    |        1（EX） | ♠2(EX)                                                                                                 | 攻击范围 2        |
| 雌雄双股剑 | `double_swords`    | 装备-武器    |              1 | ♠2                                                                                                     | 攻击范围 2        |
| 青龙偃月刀 | `blade`            | 装备-武器    |              1 | ♠5                                                                                                     | 攻击范围 3        |
| 丈八蛇矛   | `spear`            | 装备-武器    |              1 | ♠Q                                                                                                     | 攻击范围 3        |
| 贯石斧     | `axe`              | 装备-武器    |              1 | ♦5                                                                                                     | 攻击范围 3        |
| 方天画戟   | `halberd`          | 装备-武器    |              1 | ♦Q                                                                                                     | 攻击范围 4        |
| 麒麟弓     | `kylin_bow`        | 装备-武器    |              1 | ♥5                                                                                                     | 攻击范围 5        |
| 八卦阵     | `eight_diagram`    | 装备-防具    |              2 | ♠2 · ♣2                                                                                                |                   |
| 仁王盾     | `renwang_shield`   | 装备-防具    |        1（EX） | ♣2(EX)                                                                                                 |                   |
| 赤兔       | `chitu`            | 装备-坐骑 −1 |              1 | ♥5                                                                                                     | 进攻马            |
| 大宛       | `dayuan`           | 装备-坐骑 −1 |              1 | ♠K                                                                                                     | 进攻马            |
| 紫骍       | `zixing`           | 装备-坐骑 −1 |              1 | ♦K                                                                                                     | 进攻马            |
| 的卢       | `dilu`             | 装备-坐骑 +1 |              1 | ♣5                                                                                                     | 防御马            |
| 绝影       | `jueying`          | 装备-坐骑 +1 |              1 | ♠5                                                                                                     | 防御马            |
| 爪黄飞电   | `zhuahuangfeidian` | 装备-坐骑 +1 |              1 | ♥K                                                                                                     | 防御马            |

### 5.1 武器攻击范围（S1/S2/S3/S4 一致）

| 武器         | id               | 范围 | 花色点数 |
| ------------ | ---------------- | ---: | -------- |
| 诸葛连弩     | `crossbow`       |    1 | ♣A、♦A   |
| 青釭剑       | `qinggang_sword` |    2 | ♠6       |
| 寒冰剑（EX） | `ice_sword`      |    2 | ♠2       |
| 雌雄双股剑   | `double_swords`  |    2 | ♠2       |
| 青龙偃月刀   | `blade`          |    3 | ♠5       |
| 丈八蛇矛     | `spear`          |    3 | ♠Q       |
| 贯石斧       | `axe`            |    3 | ♦5       |
| 方天画戟     | `halberd`        |    4 | ♦Q       |
| 麒麟弓       | `kylin_bow`      |    5 | ♥5       |

### 5.2 坐骑

| 坐骑     | id                 |                        距离修正 | 花色点数 |
| -------- | ------------------ | ------------------------------: | -------- |
| 赤兔     | `chitu`            | −1（你计算与其他角色的距离 −1） | ♥5       |
| 大宛     | `dayuan`           |                              −1 | ♠K       |
| 紫骍     | `zixing`           |                              −1 | ♦K       |
| 的卢     | `dilu`             | +1（其他角色计算与你的距离 +1） | ♣5       |
| 绝影     | `jueying`          |                              +1 | ♠5       |
| 爪黄飞电 | `zhuahuangfeidian` |                              +1 | ♥K       |

---

## 6. 花色 × 点数矩阵（校对用）

每格列出该花色点数的全部牌（不含 EX 时每格恰 2 张；带 `(EX)` 的为第 3 张）。此矩阵与三国杀 Wiki "标准版游戏牌列表"、BWIKI "标准包卡牌"的排布方式相同，便于对照实体卡抽查。

| 点数 | 黑桃 ♠                         | 红桃 ♥                 | 梅花 ♣                 | 方块 ♦                     |
| ---: | ------------------------------ | ---------------------- | ---------------------- | -------------------------- |
|    A | 决斗、闪电                     | 万箭齐发、桃园结义     | 决斗、诸葛连弩         | 决斗、诸葛连弩             |
|    2 | 寒冰剑(EX)、雌雄双股剑、八卦阵 | 闪、闪                 | 杀、八卦阵、仁王盾(EX) | 闪、闪                     |
|    3 | 过河拆桥、顺手牵羊             | 桃、五谷丰登           | 杀、过河拆桥           | 闪、顺手牵羊               |
|    4 | 过河拆桥、顺手牵羊             | 桃、五谷丰登           | 杀、过河拆桥           | 闪、顺手牵羊               |
|    5 | 青龙偃月刀、绝影               | 麒麟弓、赤兔           | 杀、的卢               | 闪、贯石斧                 |
|    6 | 乐不思蜀、青釭剑               | 桃、乐不思蜀           | 杀、乐不思蜀           | 杀、闪                     |
|    7 | 杀、南蛮入侵                   | 桃、无中生有           | 杀、南蛮入侵           | 杀、闪                     |
|    8 | 杀、杀                         | 桃、无中生有           | 杀、杀                 | 杀、闪                     |
|    9 | 杀、杀                         | 桃、无中生有           | 杀、杀                 | 杀、闪                     |
|   10 | 杀、杀                         | 杀、杀                 | 杀、杀                 | 杀、闪                     |
|    J | 顺手牵羊、无懈可击             | 杀、无中生有           | 杀、杀                 | 闪、闪                     |
|    Q | 过河拆桥、丈八蛇矛             | 桃、过河拆桥、闪电(EX) | 借刀杀人、无懈可击     | 桃、无懈可击(EX)、方天画戟 |
|    K | 南蛮入侵、大宛                 | 闪、爪黄飞电           | 借刀杀人、无懈可击     | 杀、紫骍                   |

---

## 7. JSON 数据（可直接复制）

字段：`name`（英文 id）、`zh`（中文名）、`kind`、`suit`、`rank`、`extra`（可选：`range` 武器攻击范围；`distance` 坐骑距离修正；`ex: true` 为 EX 牌）。

`kind` 取值：`basic` | `trick` | `delayed_trick` | `weapon` | `armor` | `horse_offensive`（−1 马） | `horse_defensive`（+1 马）。
`suit` 取值：`spade` | `heart` | `club` | `diamond`；`rank` 为 1–13。

共 108 条；过滤掉 `extra.ex === true` 的 4 条即为 104 张版本。

```json
[
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "spade", "rank": 7 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "spade", "rank": 8 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "spade", "rank": 8 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "spade", "rank": 9 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "spade", "rank": 9 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "spade", "rank": 10 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "spade", "rank": 10 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "heart", "rank": 10 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "heart", "rank": 10 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "heart", "rank": 11 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 2 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 3 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 4 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 5 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 6 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 7 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 8 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 8 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 9 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 9 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 10 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 10 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 11 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "club", "rank": 11 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "diamond", "rank": 6 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "diamond", "rank": 7 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "diamond", "rank": 8 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "diamond", "rank": 9 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "diamond", "rank": 10 },
  { "name": "slash", "zh": "杀", "kind": "basic", "suit": "diamond", "rank": 13 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "heart", "rank": 2 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "heart", "rank": 2 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "heart", "rank": 13 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 2 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 2 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 3 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 4 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 5 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 6 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 7 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 8 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 9 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 10 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 11 },
  { "name": "jink", "zh": "闪", "kind": "basic", "suit": "diamond", "rank": 11 },
  { "name": "peach", "zh": "桃", "kind": "basic", "suit": "heart", "rank": 3 },
  { "name": "peach", "zh": "桃", "kind": "basic", "suit": "heart", "rank": 4 },
  { "name": "peach", "zh": "桃", "kind": "basic", "suit": "heart", "rank": 6 },
  { "name": "peach", "zh": "桃", "kind": "basic", "suit": "heart", "rank": 7 },
  { "name": "peach", "zh": "桃", "kind": "basic", "suit": "heart", "rank": 8 },
  { "name": "peach", "zh": "桃", "kind": "basic", "suit": "heart", "rank": 9 },
  { "name": "peach", "zh": "桃", "kind": "basic", "suit": "heart", "rank": 12 },
  { "name": "peach", "zh": "桃", "kind": "basic", "suit": "diamond", "rank": 12 },
  { "name": "dismantlement", "zh": "过河拆桥", "kind": "trick", "suit": "spade", "rank": 3 },
  { "name": "dismantlement", "zh": "过河拆桥", "kind": "trick", "suit": "spade", "rank": 4 },
  { "name": "dismantlement", "zh": "过河拆桥", "kind": "trick", "suit": "spade", "rank": 12 },
  { "name": "dismantlement", "zh": "过河拆桥", "kind": "trick", "suit": "heart", "rank": 12 },
  { "name": "dismantlement", "zh": "过河拆桥", "kind": "trick", "suit": "club", "rank": 3 },
  { "name": "dismantlement", "zh": "过河拆桥", "kind": "trick", "suit": "club", "rank": 4 },
  { "name": "snatch", "zh": "顺手牵羊", "kind": "trick", "suit": "spade", "rank": 3 },
  { "name": "snatch", "zh": "顺手牵羊", "kind": "trick", "suit": "spade", "rank": 4 },
  { "name": "snatch", "zh": "顺手牵羊", "kind": "trick", "suit": "spade", "rank": 11 },
  { "name": "snatch", "zh": "顺手牵羊", "kind": "trick", "suit": "diamond", "rank": 3 },
  { "name": "snatch", "zh": "顺手牵羊", "kind": "trick", "suit": "diamond", "rank": 4 },
  { "name": "duel", "zh": "决斗", "kind": "trick", "suit": "spade", "rank": 1 },
  { "name": "duel", "zh": "决斗", "kind": "trick", "suit": "club", "rank": 1 },
  { "name": "duel", "zh": "决斗", "kind": "trick", "suit": "diamond", "rank": 1 },
  { "name": "collateral", "zh": "借刀杀人", "kind": "trick", "suit": "club", "rank": 12 },
  { "name": "collateral", "zh": "借刀杀人", "kind": "trick", "suit": "club", "rank": 13 },
  { "name": "ex_nihilo", "zh": "无中生有", "kind": "trick", "suit": "heart", "rank": 7 },
  { "name": "ex_nihilo", "zh": "无中生有", "kind": "trick", "suit": "heart", "rank": 8 },
  { "name": "ex_nihilo", "zh": "无中生有", "kind": "trick", "suit": "heart", "rank": 9 },
  { "name": "ex_nihilo", "zh": "无中生有", "kind": "trick", "suit": "heart", "rank": 11 },
  { "name": "nullification", "zh": "无懈可击", "kind": "trick", "suit": "spade", "rank": 11 },
  { "name": "nullification", "zh": "无懈可击", "kind": "trick", "suit": "club", "rank": 12 },
  { "name": "nullification", "zh": "无懈可击", "kind": "trick", "suit": "club", "rank": 13 },
  {
    "name": "nullification",
    "zh": "无懈可击",
    "kind": "trick",
    "suit": "diamond",
    "rank": 12,
    "extra": { "ex": true }
  },
  { "name": "savage_assault", "zh": "南蛮入侵", "kind": "trick", "suit": "spade", "rank": 7 },
  { "name": "savage_assault", "zh": "南蛮入侵", "kind": "trick", "suit": "spade", "rank": 13 },
  { "name": "savage_assault", "zh": "南蛮入侵", "kind": "trick", "suit": "club", "rank": 7 },
  { "name": "archery_attack", "zh": "万箭齐发", "kind": "trick", "suit": "heart", "rank": 1 },
  { "name": "peach_garden", "zh": "桃园结义", "kind": "trick", "suit": "heart", "rank": 1 },
  { "name": "amazing_grace", "zh": "五谷丰登", "kind": "trick", "suit": "heart", "rank": 3 },
  { "name": "amazing_grace", "zh": "五谷丰登", "kind": "trick", "suit": "heart", "rank": 4 },
  { "name": "indulgence", "zh": "乐不思蜀", "kind": "delayed_trick", "suit": "spade", "rank": 6 },
  { "name": "indulgence", "zh": "乐不思蜀", "kind": "delayed_trick", "suit": "heart", "rank": 6 },
  { "name": "indulgence", "zh": "乐不思蜀", "kind": "delayed_trick", "suit": "club", "rank": 6 },
  { "name": "lightning", "zh": "闪电", "kind": "delayed_trick", "suit": "spade", "rank": 1 },
  {
    "name": "lightning",
    "zh": "闪电",
    "kind": "delayed_trick",
    "suit": "heart",
    "rank": 12,
    "extra": { "ex": true }
  },
  {
    "name": "crossbow",
    "zh": "诸葛连弩",
    "kind": "weapon",
    "suit": "club",
    "rank": 1,
    "extra": { "range": 1 }
  },
  {
    "name": "crossbow",
    "zh": "诸葛连弩",
    "kind": "weapon",
    "suit": "diamond",
    "rank": 1,
    "extra": { "range": 1 }
  },
  {
    "name": "qinggang_sword",
    "zh": "青釭剑",
    "kind": "weapon",
    "suit": "spade",
    "rank": 6,
    "extra": { "range": 2 }
  },
  {
    "name": "ice_sword",
    "zh": "寒冰剑",
    "kind": "weapon",
    "suit": "spade",
    "rank": 2,
    "extra": { "range": 2, "ex": true }
  },
  {
    "name": "double_swords",
    "zh": "雌雄双股剑",
    "kind": "weapon",
    "suit": "spade",
    "rank": 2,
    "extra": { "range": 2 }
  },
  {
    "name": "blade",
    "zh": "青龙偃月刀",
    "kind": "weapon",
    "suit": "spade",
    "rank": 5,
    "extra": { "range": 3 }
  },
  {
    "name": "spear",
    "zh": "丈八蛇矛",
    "kind": "weapon",
    "suit": "spade",
    "rank": 12,
    "extra": { "range": 3 }
  },
  {
    "name": "axe",
    "zh": "贯石斧",
    "kind": "weapon",
    "suit": "diamond",
    "rank": 5,
    "extra": { "range": 3 }
  },
  {
    "name": "halberd",
    "zh": "方天画戟",
    "kind": "weapon",
    "suit": "diamond",
    "rank": 12,
    "extra": { "range": 4 }
  },
  {
    "name": "kylin_bow",
    "zh": "麒麟弓",
    "kind": "weapon",
    "suit": "heart",
    "rank": 5,
    "extra": { "range": 5 }
  },
  { "name": "eight_diagram", "zh": "八卦阵", "kind": "armor", "suit": "spade", "rank": 2 },
  { "name": "eight_diagram", "zh": "八卦阵", "kind": "armor", "suit": "club", "rank": 2 },
  {
    "name": "renwang_shield",
    "zh": "仁王盾",
    "kind": "armor",
    "suit": "club",
    "rank": 2,
    "extra": { "ex": true }
  },
  {
    "name": "chitu",
    "zh": "赤兔",
    "kind": "horse_offensive",
    "suit": "heart",
    "rank": 5,
    "extra": { "distance": -1 }
  },
  {
    "name": "dayuan",
    "zh": "大宛",
    "kind": "horse_offensive",
    "suit": "spade",
    "rank": 13,
    "extra": { "distance": -1 }
  },
  {
    "name": "zixing",
    "zh": "紫骍",
    "kind": "horse_offensive",
    "suit": "diamond",
    "rank": 13,
    "extra": { "distance": -1 }
  },
  {
    "name": "dilu",
    "zh": "的卢",
    "kind": "horse_defensive",
    "suit": "club",
    "rank": 5,
    "extra": { "distance": 1 }
  },
  {
    "name": "jueying",
    "zh": "绝影",
    "kind": "horse_defensive",
    "suit": "spade",
    "rank": 5,
    "extra": { "distance": 1 }
  },
  {
    "name": "zhuahuangfeidian",
    "zh": "爪黄飞电",
    "kind": "horse_defensive",
    "suit": "heart",
    "rank": 13,
    "extra": { "distance": 1 }
  }
]
```

---

## 8. 英文 id 与各引擎命名对照

本文档的 id 以任务指定的命名为准；与两个开源引擎的差异如下，便于日后对照其技能实现（**只参考设计，不拷贝 GPL 代码**）。

| 本文 id                                   | 中文                   | FreeKill（S1）   | QSanguosha-v2（S2）        | harry5z（S3）                                |
| ----------------------------------------- | ---------------------- | ---------------- | -------------------------- | -------------------------------------------- |
| `peach_garden`                            | 桃园结义               | `god_salvation`  | `GodSalvation`             | `Brotherhood`                                |
| `renwang_shield`                          | 仁王盾                 | `nioh_shield`    | `RenwangShield`            | `IronShield`                                 |
| `double_swords`                           | 雌雄双股剑             | `double_swords`  | `DoubleSword`              | （未实现）                                   |
| `qinggang_sword`                          | 青釭剑                 | `qinggang_sword` | `QinggangSword`            | `IronSword`                                  |
| `blade`                                   | 青龙偃月刀             | `blade`          | `Blade`                    | `DragonBlade`                                |
| `spear`                                   | 丈八蛇矛               | `spear`          | `Spear`                    | `SerpentSpear`                               |
| `crossbow`                                | 诸葛连弩               | `crossbow`       | `Crossbow`                 | `ChuKoNu`                                    |
| `eight_diagram`                           | 八卦阵                 | `eight_diagram`  | `EightDiagram`             | `TaichiFormation`                            |
| `indulgence`                              | 乐不思蜀               | `indulgence`     | `Indulgence`               | `Oblivion`                                   |
| `amazing_grace`                           | 五谷丰登               | `amazing_grace`  | `AmazingGrace`             | `Harvest`                                    |
| `dismantlement` / `snatch`                | 过河拆桥 / 顺手牵羊    | 同左             | `Dismantlement` / `Snatch` | `Sabotage` / `Steal`                         |
| `jueying` / `zhuahuangfeidian` / `zixing` | 绝影 / 爪黄飞电 / 紫骍 | 同左             | 同左（`setObjectName`）    | `"Flash"` / `"GoldenLightning"` / `"Purple"` |

其余 id（`slash`、`jink`、`peach`、`duel`、`collateral`、`ex_nihilo`、`nullification`、`savage_assault`、`archery_attack`、`lightning`、`ice_sword`、`axe`、`halberd`、`kylin_bow`、`dilu`、`chitu`、`dayuan`）与 FreeKill 完全相同。

---

## 9. 存疑项与差异记录

| #   | 项目                           | 情况                                                                          | 处理                                                       |
| --- | ------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | 总张数 104 vs 108              | 同一套牌的两种计数口径（是否含 4 张 EX）。                                    | 采用 108，EX 打标记，见 §2.3。**非数据冲突。**             |
| 2   | 雌雄双股剑 ♠2                  | S3（harry5z）源码中该牌被注释掉、未实现，故 S3 只有 107 张；S1、S2、S4 一致。 | 取证等级记为"已核对（3 源一致）"，不视为存疑。             |
| 3   | 18183 "装备牌 18 张"           | 与 19（含 EX）/ 17（不含 EX）均不符；该页只能看到搜索摘要。                   | 判为该文口径错误，不采用。                                 |
| 4   | 搜索摘要"闪 方块 15 张"        | 摘要笔误；逐张来源均为 ♦12 + ♥3 = 15。                                        | 不采用摘要数字。                                           |
| 5   | EX ♦Q 牌名                     | 2008 推广版为【银月枪】，2009 标准版起为【无懈可击】。                        | 采用无懈可击（标准版口径）。                               |
| 6   | 武器攻击范围                   | 四源一致，无差异。                                                            | —                                                          |
| 7   | 界限突破新增牌（木牛流马等）   | 超出范围。                                                                    | 不收录。                                                   |
| 8   | fandom / 维基百科 / BWIKI 原页 | 本环境无法直接访问，只有搜索摘要或第三方转录（S4）。                          | 逐张数据以 S1/S2/S3/S4 为准；建议后续人工抽查 BWIKI 原页。 |

**结论：108 张逐张数据中，107 张为"已核对（4 源一致）"，1 张（雌雄双股剑）为"已核对（3 源一致）"；无"单一来源"或"存疑"条目。**
