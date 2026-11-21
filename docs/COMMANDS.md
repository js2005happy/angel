# 命令速查（全部子命令）

> 由 `tests/node/test-doc-consistency.test.ts` 机械校验：这里与 `src/cli.ts` 的 `subcommands` 集合必须**一一对应**。
> 加子命令不写进这里 → CI 红；写了不存在的命令 → 也红。

## 运行与结论

| 命令 | 作用 |
|---|---|
| `nyra` | 跑任务（默认入口，无子命令） |
| `nyra verdict [任务]` | 一条结论：这次跑得值不值（红线 + 省钱 + 回忆 + 历史） |
| `nyra verdict --run <id>` | 给单次运行打分 |
| `nyra verdict --recent N` | 最近 N 次的趋势：该修什么 |
| `nyra guard [--strict]` | 门禁形态：red 时退出码 2（`--strict` 下 yellow 也拦） |
| `nyra redlines [--json]` | 上线红线自检（证据/权限/沙箱/成本/钩子）；`--json` 给 CI 按 `code` 判定 |
| `nyra evidence verify <运行 ID>` | 独立复核运行的证据链 |
| `nyra timeline <运行 ID> [--verbose] [--json] [--out <路径>]` | 执行时间线：按时间重建一次多 agent 任务（只读回放，不重新执行） |
| `nyra replay <运行 ID> [--verbose]` | 会话回放：按轮次逐步重现一次运行的关键步骤（只读，不重新执行） |
| `nyra regression <list\|precipitate --run <运行 ID>\|remove <用例 id>\|status <用例 id> <open\|verified\|retired>>` | 回归测例库：把一次运行的失败步骤沉淀为回归用例（只记元数据，不调模型、不自动重跑，详见 `docs/regression.md`） |
| `nyra "任务" --image <图片路径> [--image ...] [--video <视频路径或链接>]` | 图像/视频输入：图片进首轮用户消息，视频先抽帧再进（模型须支持看图，详见 docs/vision.md） |
| `nyra --voice <音频路径> ["任务"]` | 语音指挥：先转文字再当任务跑（本地 whisper 优先、云端兜底；详见 docs/voice.md） |
| `nyra "任务" --speak` | 任务跑完后把结果读出来（默认关；只读结果前 500 字） |
| `nyra restore [检查点]` | 从影子快照恢复文件与会话 |

## 成本与用量

| 命令 | 作用 |
|---|---|
| `nyra cost --show` | 定价、单次上限、月度上限与本月已花 |
| `nyra cost --estimate "<任务>"` | 成本预估（含回忆感知的下调） |
| `nyra savings [任务]` | 省钱机制汇总 + 辅助模型实测节省 + 逐模型明细 |
| `nyra stats [--heatmap]` | 本月用量与每日热力图 |

## 配置与开关

| 命令 | 作用 |
|---|---|
| `nyra config export / import` | 设置导出与导入（默认剔除密钥；越权字段需 `--allow-dangerous`） |
| `nyra config explain [能力]` | 这个能力由哪个键控制、现在生效吗 |
| `nyra features` | 功能开关列表（CLI > config > 默认） |
| `nyra tools` | 工具集体检：每轮 schema 成本与裁剪建议 |
| `nyra models [list\|show\|refresh]` | 模型上下文窗口查询与刷新 |
| `nyra reviewer <status\|enable\|disable\|set-model\|add-rule\|remove-rule\|list-rules\|check>` | 独立审查层：敏感工具调用先过独立审查 agent，审查失败即拦截（详见 `docs/reviewer.md`） |
| `nyra verifier <status\|enable\|disable\|set-model\|rework-on\|rework-off\|add-rule\|remove-rule\|list-rules\|check>` | 验收者：并行产出合入前先验收，不通过打回重做，结论进证据链（详见 `docs/verifier.md`） |
| `nyra account <status\|login\|logout\|list\|revoke\|link\|suspend\|reactivate>` | 用户账号登录：Google / GitHub / 邮箱 / SSO，账号身份 + 会话（详见 `docs/accounts.md`） |
| `nyra sso <provider\|login\|status\|scim>` | 缺口 43 第二批：企业 SSO——OIDC 身份提供方注册与登录、SCIM 账号开通（详见 `docs/sso.md`） |

## 记忆与复用

| 命令 | 作用 |
|---|---|
| `nyra recall "<任务>" [--cross-dir]` | 查这个任务有哪些历史可复用 |
| `nyra memory <export\|import\|search\|forget…>` | 记忆交换与检索/删除 |
| `nyra soul <show\|status\|list\|init\|add\|remove\|enable\|disable\|edit\|export\|import>` | Soul 身份层：每 agent 的身份与 Tenets，不变量编译进规则层、代码拦截（详见 `docs/soul.md`） |
| `nyra style <learn\|show\|list\|delete…>` | 分应用文风学习 |
| `nyra skills <status\|enable\|disable\|draft\|drafts\|show\|approve\|reject\|archive\|sweep>` | 技能自沉淀：成功任务自动起草技能草稿，人工批准后才安装，低质自动归档（详见 `docs/skill-sedimentation.md`） |
| `nyra bughunt <install\|status\|scope\|template\|check>` | 授权漏洞挖掘技能包：范围卡 + 证伪验证 + 提交前七问 + 证据卫生，提交前核对（详见 `docs/bughunt.md`） |
| `nyra market <list\|show\|source\|install\|uninstall\|installed\|publish\|template>` | 内置机器人市场：浏览、安装、发布技能包与机器人配置，三道门审查 + Bot Ready 评分 + 安装账本（详见 `docs/marketplace.md`） |

## 后台与协作

| 命令 | 作用 |
|---|---|
| `nyra ui` | 启动 gateway 网页界面（含手机 PWA） |
| `nyra gw <sessions\|send\|view\|approve…>` | 连正在跑的 gateway 当客户端 |
| `nyra schedule <list\|add\|remove\|run\|daemon>` | 定时任务（`add` 可加 `--agent <名字>`，让任务跑在该 Bot 的电脑里） |
| `nyra events <list\|add\|remove\|enable\|disable\|test\|poll>` | 事件触发任务：webhook 与新邮件触发进任务队列（详见 `docs/event-triggers.md`） |
| `nyra mail-inbox <status\|enable\|disable\|allowlist\|set\|poll>` | 邮件即任务入口：白名单发件人的邮件直接进任务队列，跑完回信（详见 `docs/mail-inbox.md`） |
| `nyra responsibility <list\|add\|remove\|enable\|disable\|check>` | 常驻责任巡查：领一份持续责任、自己定复查节奏，无人值守时强制只读（详见 `docs/responsibilities.md`） |
| `nyra bot telegram <start\|stop\|status>` | Bot 方向 Phase 1+2+3：Telegram 渠道（长轮询收消息、会话串行、去重配额、确定性指令；角色路由与聊天内审批；主动推送 notifier 与附件处理，详见 `docs/bot.md`） |
| `nyra bot discord <start\|stop\|status>` | Bot 方向：Discord 渠道（Gateway 收 MESSAGE_CREATE 事件、REST 发/编辑消息；需 Message Content Intent，详见 `docs/bot.md`） |
| `nyra bot redlines <status\|list\|show\|tighten\|loosen\|set>` | Bot 缺口 51：业务动作硬红线表——发消息/付款/删除永远须人批，转钱/交易证券永远禁做（详见 `docs/business-redlines.md`） |
| `nyra bot computer <create\|list\|status\|sleep\|wake\|remove\|credential\|shell\|sleep-due>` | Bot 缺口 42 第一批 + 第二批：每 Bot 一台持久电脑——持久 workspace + 浏览器 profile + 凭证 Vault + 隔离分级；第二批 BotRunner 接线：Bot 启动时绑电脑、Agent 在电脑的 workspace 里跑、`/computer-shell`（详见 `docs/bot-computer.md` 与 `docs/bot.md`） |
| `nyra bot status` | Bot 总览：Telegram/Discord 运行态 + 电脑数量与资源，本 Bot 的电脑带标注（详见 `docs/bot.md` 与 `docs/bot-computer.md`） |
| `nyra task <add\|list\|show\|cancel\|worker\|approve>` | 后台任务队列 |
| `nyra kanban <create\|list\|show\|start\|fail\|review\|decide\|verify\|done\|reset\|remove\|tick\|sweep>` | 缺口 26：持久任务板——任务是账本里的一行，崩溃不丢、熔断进 blocked、完成须附验证证据（详见 `docs/kanban.md`） |
| `nyra subagent <list\|show\|register\|heartbeat\|sweep\|resume\|suspend>` | 缺口 30：崩溃自续——子 agent 持久行 + 心跳检查点 + 启动扫荡 + 先验状态再续跑（详见 `docs/kanban.md`） |
| `nyra side-effects <list\|show\|record\|mark\|recover>` | DSH-4：先存后做的副作用队列——执行前先落库，重启按年龄恢复、带 recovery note（详见 `docs/kanban.md`） |
| `nyra heartbeat <add\|list\|remove\|enable\|disable\|run\|commitments>` | 缺口 31：静默巡查——无事安静、有发现先记证据再写收件箱；推断承诺须用户确认一次、过期自动失效（详见 `docs/heartbeat.md`） |
| `nyra governance <policy\|mandate\|mode\|dry-runs>` | 缺口 43：企业治理——版本化策略 + 不可变授权 + observe/auto 接单模式 + 干跑记录（详见 `docs/governance.md`） |
| `nyra governance caps <set\|list\|show\|check\|assign-team\|pause\|resume\|discard\|pauses>` | 缺口 43 第三批：分层成本上限——按 Bot/角色/团队/人设设月度美元与 token 上限，触顶进可恢复暂停态，放宽留痕（详见 `docs/governance.md`） |
| `nyra governance audit <export\|verify>` | 缺口 43 第三批：审计导出——治理审计日志导出给 SIEM（JSONL + 哈希链，可验证；详见 `docs/governance.md`） |
| `nyra kanban pause <id> "<原因>"` / `nyra kanban resume <id>` | 缺口 43 第三批：任务板 `paused` 状态——分层上限触顶暂停（可恢复，attempts 不动） |
| `nyra optimize <propose\|list\|show\|edit\|approve\|reject\|apply\|verify\|revert>` | G-4：带人批的自优化环——只起草改指令建议，须人批才生效，三数据集 + holdout 定放行（详见 `docs/governance.md`） |
| `nyra review <list\|show\|approve\|reject\|apply…>` | 审阅队列：逐项批准并行线程与定时任务结果 |

## 扩展与集成

| 命令 | 作用 |
|---|---|
| `nyra plugin <list\|search\|install\|enable…>` | 插件市场（只装带来源、可审计的技能包） |
| `nyra creator "<一句话需求>"` | 创造模式：一句话搓出插件（先验证、经确认才安装） |
| `nyra kb <create\|list\|add\|search\|ask>` | 本地知识库 |
| `nyra hooks list` | 列出已安装的钩子 |
| `nyra permissions` | Poppy 站点授权意向（本地账本，只记录不授权） |
| `nyra eigenflux` | EigenFlux 接入检测与本地网络限制 |
| `nyra gmail <status\|auth\|search\|read\|send\|labels\|label\|unlabel\|mark-read\|mark-unread\|trash\|attachment\|revoke>` | Gmail 连接器：读邮件、按 thread 回复、代发草稿（发信走审批）；附件只读下载、标签、标已读、进回收站（写操作须显式确认；永久删除不提供，详见 `docs/connectors-gmail.md`） |
| `nyra connector <status\|list\|approve\|revoke>` | 连接器授权状态机：每应用一次批准、过期与撤销（详见 `docs/connectors.md`） |
| `nyra shopify <auth\|status\|products\|product\|orders\|order\|inventory>` | Shopify 连接器（只读）：查商品、订单、库存；写操作一律拒绝（详见 `docs/connectors.md`） |
| `nyra slack <auth\|status\|channels\|history\|send\|card>` | Slack 连接器：读频道/消息、发消息（须显式批准）、发审批卡；删消息/改频道/管理成员一律拒绝（详见 `docs/connectors.md`） |
| `nyra mcp server <status\|enable\|disable\|allow-writes-on\|allow-writes-off>` | 对外 MCP 服务开关：别的 agent 经网关 `POST /mcp` 调 Nyra 的记忆与任务（默认关闭；写操作须显式开且过独立审查，详见 `docs/mcp.md`） |
| `nyra peer <status\|enable\|disable\|list\|auth\|ask\|handoff>` | 对端协作：问别的 Nyra 实例、交接运行上下文（默认关闭；对外发送须开独立审查，详见 `docs/peer.md`） |
| `nyra voice <status\|speak <文字>\|enable-tts\|disable-tts>` | 语音指挥：看配置与可用性、读一段文字、开关自动回读（默认关；详见 `docs/voice.md`） |
| `nyra export --format docx\|xlsx\|pptx --from <内容 JSON> --out <路径>` | 成品导出：结构化内容写成可编辑的真办公文件，附事实核查（详见 `docs/office.md`） |
| `nyra media <status\|enable\|disable\|ingest <链接> [--out <路径>]\|setup\|scope …>` | 媒体抓取：公开视频 → 字幕/转写 → 文本（默认关；yt-dlp 二进制须 `nyra media setup` 按官方 release 下载并验签安装；详见 `docs/media-ingest.md`） |

## 自检与运维

| 命令 | 作用 |
|---|---|
| `nyra doctor [--provider 名字]` | 中文自检：运行时、配置、Key、网络、磁盘、写权限、密码箱 |
| `nyra status` | 诊断清单：坏配置、不可用沙箱、被忽略的权限、永不匹配的 hook matcher |
| `nyra setup` | 首次启动向导 |
| `nyra vault` | 凭据保险箱（加密存储，权限 0600） |

## 为什么需要这一页

之前没有任何一处把全部子命令列全，于是：

- 我加的 `tools` / `features` / `recall` / `savings` 只散在各自文档里
- CI 无法发现「代码有、文档没有」或「文档有、代码没有」

这一页 + 那条测试就是兜住这件事的机械手段。

## 事件与常驻（本轮补齐）

| 命令 | 作用 |
|---|---|
| `nyra events <list\|add\|remove\|enable\|disable\|test\|poll>` | 事件触发任务：webhook 与新邮件触发进任务队列（详见 [events.md](./events.md)） |
| `nyra mail-inbox <status\|enable\|disable\|allowlist\|set\|poll>` | 邮件即任务入口：白名单发件人的邮件直接进队列，跑完回信 |
| `nyra responsibility <list\|add\|remove\|enable\|disable\|check>` | 常驻责任巡查：自己定复查节奏，无人值守时强制只读 |