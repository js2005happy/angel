# 对端协作（缺口 12）：Agent 间直接协作

两个 Nyra 实例之间可以直接协作：互相提问、交接任务、共享上下文。
本批只做**异步**协作（问一句、等一段回答；交过去、对方续跑）。
实时视频会是缺口 39 的事。

## 快速开始

1. 在对端（B）上开启对外 MCP 服务并拿到网关 token：

```sh
nyra mcp server enable
nyra gw status   # 看网关地址与 token（token 只在 B 的本机上能看到）
```

2. 在本机（A）的 `config.json` 里配对端（名字 + 网关 `/mcp` 地址）：

```json
{
"peers": {
  "enabled": true,
  "list": [{ "name": "b", "url": "http://192.168.1.20:8080/mcp" }]
}
}
```

3. 开启对端协作与独立审查层（两道门，缺一不可）：

```sh
nyra peer enable
nyra reviewer enable
```

4. 给对端存网关 token（只存密码箱，不写进 config）：

```sh
nyra peer auth b
```

5. 问一句 / 交接一次运行：

```sh
nyra peer ask --to b "周报一般怎么写？"
nyra peer handoff --to b --run 20261120-120000-abcdef
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `nyra peer status` | 查看对端协作状态（是否开启、已配对端） |
| `nyra peer enable \| disable` | 开启 / 关闭对端协作（默认关闭） |
| `nyra peer list` | 列出已配对端（名字与地址，不含令牌） |
| `nyra peer auth <名字>` | 给对端存网关 token（只存密码箱） |
| `nyra peer ask --to <名字> [--timeout N] <问题>` | 问对端一个问题并等答复（默认等 180 秒，最长 600 秒） |
| `nyra peer handoff --to <名字> --run <运行ID> [--mode readonly\|auto] [--share evidence]` | 把一次运行的上下文交接给对端续跑（默认只读） |

退出码：0 成功、1 运行失败（对端拒了、网络不通、运行不存在）、2 用法错误。

## 互问是怎么跑的

`ask` 调对端对外 MCP 服务的新只读工具 `answer_question`：
对端用只读 agent 短跑（最多 4 轮）回一段回答（截到 4000 字）。
回答花的是**对端**的 token；本机只记“问过”这一事实。

对端不可信：答复只当作外部输入，过 `wrapUntrusted` 再用，
答复里的指令、链接、文件路径一律按不可信输入处理，绝不直接当指令执行。

## 交接包里有什么、没有什么

交接包从源运行的 `state.json` 与 `events.jsonl` 拼出来，
**不读会话文件**（完整对话历史不共享）。

| 字段 | 默认 | 内容 |
| --- | --- | --- |
| `task` | 共享 | 任务描述（已脱敏） |
| `conclusions` | 共享 | 已验证的结论（验收结论；没有时写明“没有已验证的结论”） |
| `steps` | 共享 | 已做步骤（工具名 + 成功/失败，不含参数） |
| `todos` | 共享 | 待办（挂起的审批、中断提示） |
| `evidence` | 不共享 | 事件类型计数 + 事件总数（只共享类型摘要，不共享事件内容） |

`evidence` 须 `--share evidence` 显式加。包里永远没有：
令牌、密码、绝对路径（先过 `redact` 再把 home 与工作目录替换成占位符）、
完整对话历史。

对端收到后以只读模式入队续跑（`dispatch_task`，默认 `readonly`）；
`--mode auto` 时对端按自己的审批跑写操作，写操作仍须对方显式接受。
对端接下后回 `run_id` 即记 `accepted`；对端审查拦截或入队失败记 `rejected`。

## 三处审计

每次互问 / 交接都写三处，只记元数据与指纹，不记问题原文、答复原文与交接包内容：

- **Beads 账本** `~/.nyra/peer-handoffs.jsonl`：谁交的、交了什么、对方接没接
（`sent` / `accepted` / `rejected` / `failed` / `answered`，可按 id 查）。
这是报告里 Beads（任务、决策、依赖、进度以原子单元记下来）的最小落地；
完整的 Beads（任务拆解、依赖图、git backed 同步）是后续批次。
- **对端审计** `~/.nyra/peer-audit.jsonl`：每次调用一行（对端名、动作、指纹、结论）。
- **运行事件** `peer_asked` / `peer_handoff`：进证据链，`nyra timeline` 能看到
（“问对端 B（已答复）”“交接给对端 B（accepted）”）。

## 安全边界

- 默认关闭：`peers.enabled` 与 `mcp_server.enabled` 都默认 `false`，
对端协作与对外服务各开各的门。
- 对外发送是写操作：须过独立审查层（虚拟动作 `peer_ask` / `peer_handoff`），
审查层未开启时直接拒绝（fail-closed），不是静默放行。
- 不做局域网自动发现、不扫网段：对端须用户显式配，名字只认字母数字、
下划线与连字符，地址只认 `http://` / `https://`。
- 对端网关 token 的读取顺序：`NYRA_PEER_TOKEN_<名字>` 环境变量 →
密码箱条目 `peer-token-<名字>`（`NYRA_PEER_TOKEN_<名字>` 里的名字大写，
非字母数字转下划线）。没有 token 时调用方按 403 的报错文案指引用户去存。
- 对端花的 token 记在对端自己的账本里；本机不掌握对端花了多少，
审计里只记“问过 / 交过”这一事实。

## 已知局限

- 真实对端未接通过，只在假对端（本机 HTTP）上验过。
- `answer_question` 的回答花对端 token、无单独计费（对端自己的用量账本会记）。
- 实时视频会（多人多 agent 视频会）是缺口 39 的事，本批只做异步。
- 局域网自动发现没做；跨用户互问的“对方是谁”只认对端名，不做身份认证
（网关 token 是唯一的鉴权手段，见 `docs/mcp.md`）。
- Windows / macOS 真机未验证。
