# 业务动作硬红线表（Bot 缺口 51）

一张声明式的硬红线表，按业务动作逐项定三档：**自由做 / 永远须人批 / 永远禁做**。
这是“Bot 敢碰业务”的安全前提，也是缺口 43（策略网关）的第一份策略内容。

> 注意：这张表与 `nyra redlines`（上线红线自检，见 `docs/VISION-NEXT.md` 第七节）
> 是两个东西——那个是上线前的配置体检，这个是业务动作的三档策略表。
> CLI 入口是 `nyra bot redlines ...`，不是 `nyra redlines`。

## 三档

| 档位 | 含义 | 动作 |
|---|---|---|
| 自由做（`free`） | 不用批，直接做 | 起草、查询 |
| 永远须人批（`approve`） | 每次都要有人批，没批不做 | 发消息、付款、签署文件、删除信息、改密码、转账 |
| 永远禁做（`never`） | 即使已批准也不做 | 交易证券、在账户之间转移资金、收集卡号、收集身份证号、冒充真人身份对外联系 |

起草与发出分离：起草（`draft`）自由做，发出（`send_message`）永远须人批——
草稿先进证据链，人批了才发出。

## 表在哪

- 默认表在代码里（`src/businessRedlines.ts` 的 `DEFAULT_GLOBAL_REDLINES` 与
  `DEFAULT_CONNECTOR_REDLINES`）：全局一张默认表 + 每个已落地连接器（Gmail /
  Shopify / Slack）各一份默认表；表里没写的动作回退到全局默认。
- 用户改动只存在账本 `~/.nyra/business-redlines.json`（原子写 0600，损坏先
  备份再抛错，不静默重建）。账本里只有“改动”（overrides）与变更记录，默认
  表不在账本里——删账本就回到默认表。
- 没有红线表的连接器不允许接业务系统：未知连接器的动作一律按“永远禁做”
  处理（fail-closed）。

## 改表：收紧自由、放松须批

- 收紧（向更严一档改：自由做→须人批→禁做）随时可改，不用批准。
- 放松（向更松一档改）须显式批准（`--yes`）并记原因（`--reason`），缺一
  个都不改；改动记进账本的 `changes` 与审计文件
  `~/.nyra/business-redlines-audit.jsonl`，变更事件 `redline_changed`
  只记原因指纹（SHA-256 前 12 位），不记原因原文。
- 红线不可被 Bot 自己的 Custom Rules 覆盖：确定性红线判定跑在权限规则
  （用户的自定义规则）与模型审查之前——红线是硬边界，模型与自定义规则
  都改不了它。

## 执行位置（不在提示词里）

红线在三个地方执行，缺一不可：

1. **工具审批链**（`src/tools.ts` 的 `checkApproval`）：永远禁做档在权限
   规则之前拦——即使权限规则写了 allow、即使已批准、即使是幂等重试，也
   照样拦。拦截记 `redline_blocked` 事件 + 一行审计。
2. **独立审查层**（`src/reviewer.ts` 的 `reviewToolCall`）：审查开启时，
   映射到的业务动作是禁做档的工具调用直接 BLOCK（`rule: redline-never`），
   不进模型审查；结论进 `reviewer_verdict` 事件。
3. **Bot 审批桥**（`src/bot/index.ts` 的 `approveViaBridge`）：禁做档的
   工具直接拒绝、不建挂起审批（不浪费一次人工审批）；须人批档走正常审批链。
4. **连接器 CLI**（`nyra gmail send` / `nyra slack send`）：发消息前先过
   红线——须人批档由 `--yes` / 交互确认满足；收紧到禁做档时即使已确认也拒绝。

目前映射到业务动作的 agent 工具只有一个：`gmail_send` → Gmail 的
`send_message`。以后 44 号连接器的写工具落地时，在
`src/businessRedlines.ts` 的 `TOOL_BUSINESS_ACTIONS` 里加映射——映射本身
就是“这个工具在干什么业务”。

## CLI

```
nyra bot redlines status                                    红线表状态
nyra bot redlines list                                      列出全局默认表 + 各连接器的有效表
nyra bot redlines show <连接器>                             看某连接器的有效表
nyra bot redlines tighten <连接器> <动作>                   收紧一档
nyra bot redlines loosen <连接器> <动作> --reason <原因> --yes   放松一档
nyra bot redlines set <连接器> <动作> <档位> [--reason <原因> --yes]  直接定档
```

动作：`draft query send_message pay sign delete change_password transfer
trade_securities transfer_funds collect_card collect_id impersonate`

档位：`free`（自由做）/ `approve`（永远须人批）/ `never`（永远禁做）

退出码：0 成功、1 运行失败、2 用法错误。

## 证据链

- `redline_changed`：哪个连接器、哪个动作、从哪档到哪档、原因指纹。
- `redline_blocked`：哪个连接器、哪个动作、哪档、哪个工具。
- 两事件都只记元数据与指纹，不记原因原文、不记业务内容；时间线里可见
  （`nyra timeline <运行 ID>`）。

## 已知局限

- 工具映射目前只有 `gmail_send` 一个：`http_post` 是通用外发通道，业务
  含义不明，没进映射——它仍走独立审查 + 审批，不是不管；以后按连接器
  补映射。
- 策略网关（缺口 43）还没做：红线现在由审查层、审批链与连接器 CLI 三处
  执行，网关层面的统一 choke point 是下一批。
- 账本在单机文件里：多 Bot / 多租户共享同一张表是缺口 49 的事，本批不做。
- 真实业务系统未接通验证：只在假 transport 与假审查 runner 上验过。
