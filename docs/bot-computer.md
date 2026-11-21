# 每 Bot 一台持久电脑（缺口 42 第一批 + 第二批 BotRunner 接线）

每个 Bot（Soul 身份）拥有一台自己的持久电脑：自己的工作目录、自己的
浏览器配置与登录态、自己的 shell。Bot 关机/离线后电脑仍在（文件与登录态
都在），下次唤醒接着干；Bot 的记忆、Routine、技能挂在这台电脑上，而不是
挂在一次会话里。这是 Nyra 从“agent”变成“Bot”的标志件。

本批只做第一批（报告 §7 定义）：持久 workspace + 浏览器 profile + 凭证
Vault + 隔离分级。容器后端（缺口 18 未做）与 gVisor 等重件放后几批；
真正的浏览器操作（打开页面、看屏幕）是缺口 50 的事，本批只管 profile。

**第二批（BotRunner 接线，见 `docs/bot.md` 的“Bot 与电脑”一节）**：Bot
启动时按 `bot.agent` 绑上自己那台电脑（已有就用、有 Soul 没电脑就自动建、
没 Soul 就不接并提示，任务照常在启动目录跑）；Agent 的工作目录就是电脑
的 workspace，消息到了先唤醒电脑、跑完记一笔 `task.run` 活动；聊天里的
`/computer-shell` 让机主/管理员在指定电脑上跑 shell，跨电脑写操作走
`checkComputerAccess` 的 ask 判定再进审批流。

## 一台电脑是什么

```
~/.nyra/
├── bot-computers.json          # 电脑账本（原子写 0600，损坏先备份再抛错）
├── bot-computer-activity.jsonl # 活动账本（append-only，0600）
└── computers/<电脑 id>/
    ├── workspace/              # 这台电脑的工作目录（0700）
    └── profile/
        ├── profile.json        # 浏览器配置清单（浏览器、账号名、上次访问 host）
        └── ...                 # 浏览器配置数据（以后由浏览器操作写）
```

- **一台电脑一个主人**：电脑挂在 Soul 身份下（`nyra soul init` 先建身份），
  每 agent 只能有一台电脑；建第二台会直接拒绝（先删旧的再建新的）。
- **workspace**：电脑里跑命令、改文件的地方，工作目录就是这台电脑的
  workspace；shell 落在现有 bwrap 沙箱上（workspace-write 档位）。
- **profile**：浏览器配置目录。记浏览器种类（chromium/firefox）、存了
  凭证的账号名、上次访问的 host；不记密码、不记完整 URL、不记页面内容。

## 命令

```bash
# 建一台电脑（Soul 须已存在）
nyra bot computer create --agent <Soul> [--name <名>] [--memory-mb <MB>] [--cpu-percent <%>] [--idle-sleep-minutes <分>] [--browser chromium|firefox] [--notes <备注>]
# 共享电脑（须显式 opt-in：记下谁接受的）
nyra bot computer create --agent <Soul> --shared --accepted-by <名字>

nyra bot computer list [--agent <Soul>]
nyra bot computer status <电脑 id>
nyra bot computer sleep <电脑 id> [--reason <原因>]
nyra bot computer wake <电脑 id>
nyra bot computer remove <电脑 id> [--yes]              # 不可恢复，删目录与全部凭证
nyra bot computer sleep-due                            # 把闲置到点的电脑全部休眠

# 凭证 Vault（Bot 看不到密码，由应用代填）
nyra bot computer credential <电脑 id> store --account <账号>   # 交互输入凭证
nyra bot computer credential <电脑 id> list                  # 只给掩码与来源
nyra bot computer credential <电脑 id> remove --account <账号>

# 在电脑的 workspace 里跑一条命令（bwrap 沙箱）
nyra bot computer shell <电脑 id> <命令...> [--timeout <秒>] [--cred <账号> ...]
# --cred 把 Vault 里该账号的凭证代填进沙箱环境变量 NYRA_CRED_<账号大写>，
# 命令里用 $NYRA_CRED_<账号> 引用（可重复）；没存的账号直接报错、命令不跑

# 总览：渠道运行态 + 电脑数量与资源
nyra bot status
```

默认值：内存 1024 MB（夹在 256–8192）、CPU 50%（夹在 10–100）、
闲置 15 分钟可休眠（0 = 永不自动休眠）、浏览器 chromium。

## 隔离分级（默认独占）

| 档位 | 谁能读 | 谁能写 |
| --- | --- | --- |
| dedicated（独占，默认） | 只有主人 | 只有主人 |
| shared（共享） | 谁都能读 | 只有主人能直接写；别人须经审批（ask） |

- 共享只允许在用户显式 opt-in 的受信场景：创建时必须 `--shared
  --accepted-by <名字>`，接受者记进账本；不记接受者建不了共享电脑。
- 休眠的电脑：读元数据可以，写操作拒绝（先 `wake`）。
- 判定在 `checkComputerAccess`（纯函数，`src/bot/computer.ts`）：ask 的
  调用方走已有的审批流（approvalBridge / checkApproval），批了才执行、
  批了谁记进活动账本的 `approvedBy`。CLI 上 `shell` 是电脑主人直接执行，
  不走审批（人就在终端前）。

## 凭证 Vault（学 Dusk 的 Vault）

- 凭证只存密码箱（已解锁时）或 keys.json（未解锁时，与模型 Key 同口径，
  解锁后可搬进密码箱）；密码箱里的条目名是
  `BOTCMP_<电脑 id 大写 hex>_<账号大写>`，与别的凭证不串。
- Bot 看不到密码：取明文的 `getComputerCredential` 只供应用层代填
  （浏览器自动填表）调用，绝不进提示词、绝不进日志、绝不进事件与审计原文；
  `list` 与 `status` 只给掩码与来源。
- **凭证代填（第二批）**：`runComputerShell` 的 `credentials`（CLI 是
  `--cred`，聊天里是 `/computer-shell` 的 `--cred`）把 Vault 明文放进沙箱
  进程的环境变量 `NYRA_CRED_<账号大写>`，命令用 `$NYRA_CRED_<账号>` 引用；
  每填一个记一笔 `credential.used` 活动（只记账号 + 掩码）；返回值里的
  `filledValues` 只供调用方做回复脱敏（回显前把明文替换成 `***`），绝不记
  日志、绝不进事件；没存的账号直接抛错、命令不跑。
- 删电脑时清掉这台电脑的全部凭证条目；凭证在密码箱里且密码箱未解锁时
  拒绝删（免得删完账本却留着凭证孤儿）。

## 成本账先算

- 创建时声明内存/CPU 上限与闲置休眠；已声明内存超过系统总内存 80% 时
  创建直接拒绝（超限不静默扩容），报错里写清已声明多少、上限多少。
- CPU 超配只告警不拒绝（CPU 份额可超分，内存不能）：`nyra bot status`
  与 `list` 里会亮出“CPU 已超配”。
- 闲置休眠：`idleSleepMinutes` 到了就进 `sleep-due` 清单；休眠可逆，
  `wake` 即恢复，文件与登录态都在。

## 电脑即证据

电脑里做的每一步都进活动账本（`bot-computer-activity.jsonl`），有运行
上下文时再镜像一条运行事件（只记元数据）：

| 活动 | 账本 action | 运行事件 |
| --- | --- | --- |
| 创建 | `computer.created` | `bot_computer_created`（电脑、agent、隔离） |
| 浏览器访问 | `browser.open` | `bot_computer_action`（电脑、browser、动作、host、成没成） |
| shell 命令 | `shell.run` | `bot_computer_action`（电脑、shell、动作、命令摘要、成没成） |
| 消息任务 | `task.run` | `bot_computer_action`（电脑、task、动作、会话 key、花费、成没成；不记用户原文） |
| 凭证代填 | `credential.used` | `bot_computer_credential`（电脑、账号、掩码） |
| 休眠/唤醒/删除 | `computer.sleep` / `computer.wake` / `computer.removed` | `bot_computer_lifecycle`（电脑、动作、原因） |
| 凭证存/删 | `credential.stored` / `credential.removed` | `bot_computer_credential`（电脑、账号、存/删） |

目标只记 host / 相对路径 / 命令摘要（截到 120 字），绝不记凭证、绝不记
绝对路径、绝不记文件内容。时间线里电脑动作按工具步骤渲染（失败的会进
回归沉淀的失败口径，与 G-3 同款）。

## 已知局限（诚实边界）

- 没有容器后端（缺口 18 未做）：隔离靠目录 + 权限边界兜底，不是容器级
  隔离；一台电脑的进程看不到另一台电脑的文件是靠路径与访问判定保证的，
  不是靠命名空间。
- CPU 上限只记声明、不做 cgroup 强制执行；内存上限只在创建时做总量
  核算，不做运行时强制回收。
- 浏览器 profile 只管配置与登录态清单：本批不真正打开页面、不看屏幕
  （打开页面与看屏幕是缺口 50 的事）；`recordBrowserVisit` 是供缺口 50
  调用的记录接口。
- 真实 Bot 未接通验证（Telegram/Discord token 仍等用户）：电脑的创建、
  休眠、凭证、shell 只在本地假 transport 与假浏览器 profile 上验过；
  shell 测试用 PATH 里的假 bwrap 脚本（与 `test-sandbox.test.ts` 同款），
  不依赖真实 bwrap。
- `nyra bot computer shell` 是机主在终端前直接执行（按电脑主人名义），
  不走审批；别的 agent 要在这台电脑上写东西，须先过 `checkComputerAccess`
  的 ask 判定再走审批流——BotRunner 侧的接线已在第二批做完（聊天里的
  `/computer-shell`，见 `docs/bot.md`）；`runComputerShell` 的 `approvedBy`
  非空表示调用方已经批过，不再重复拦 ask，只拦 deny。
