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

## 记忆与复用

| 命令 | 作用 |
|---|---|
| `nyra recall "<任务>" [--cross-dir]` | 查这个任务有哪些历史可复用 |
| `nyra memory <export\|import\|search\|forget…>` | 记忆交换与检索/删除 |
| `nyra style <learn\|show\|list\|delete…>` | 分应用文风学习 |
| `nyra skills <status\|enable\|disable\|draft\|drafts\|show\|approve\|reject\|archive\|sweep>` | 技能自沉淀：成功任务自动起草技能草稿，人工批准后才安装，低质自动归档（详见 `docs/skill-sedimentation.md`） |
| `nyra bughunt <install\|status\|scope\|template\|check>` | 授权漏洞挖掘技能包：范围卡 + 证伪验证 + 提交前七问 + 证据卫生，提交前核对（详见 `docs/bughunt.md`） |

## 后台与协作

| 命令 | 作用 |
|---|---|
| `nyra ui` | 启动 gateway 网页界面（含手机 PWA） |
| `nyra gw <sessions\|send\|view\|approve…>` | 连正在跑的 gateway 当客户端 |
| `nyra schedule <list\|add\|remove\|run\|daemon>` | 定时任务 |
| `nyra events <list\|add\|remove\|enable\|disable\|test\|poll>` | 事件触发任务：webhook 与新邮件触发进任务队列（详见 `docs/event-triggers.md`） |
| `nyra mail-inbox <status\|enable\|disable\|allowlist\|set\|poll>` | 邮件即任务入口：白名单发件人的邮件直接进任务队列，跑完回信（详见 `docs/mail-inbox.md`） |
| `nyra responsibility <list\|add\|remove\|enable\|disable\|check>` | 常驻责任巡查：领一份持续责任、自己定复查节奏，无人值守时强制只读（详见 `docs/responsibilities.md`） |
| `nyra task <add\|list\|show\|cancel\|worker\|approve>` | 后台任务队列 |
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
| `nyra gmail <status\|auth\|search\|read\|send\|revoke>` | Gmail 连接器：读邮件、按 thread 回复、代发草稿（发信走审批，详见 `docs/connectors-gmail.md`） |

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