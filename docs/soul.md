# Soul 身份层（缺口 28）

每个 agent 一份 Soul 文件：身份 + 信奉的规则（Tenets），与模型配置分文件存放。换模型只改 `config.json` 的 provider/model，Soul 不动——换脑不换魂。

## Soul 文件

`~/.nyra/souls/<agent>.json`（0600，souls 目录 0700；损坏先备份再抛错，不静默重建）：

```json
{
  "version": 1,
  "agent": "default",
  "identity": {
    "name": "Nyra",
    "persona": "说话直接、有事说事",
    "goal": "帮机主把重复工作自动化"
  },
  "tenets": [
    {
      "id": "ten_0123456789ab",
      "kind": "invariant",
      "text": "绝不删文件",
      "deny": ["shell(rm *)"],
      "source_session": "20261121-040000-abcdef",
      "created_at": "2026-11-21T04:00:00.000Z",
      "enabled": true
    }
  ],
  "memory_index": {
    "files": [{ "path": "MEMORY.md", "entries": 42, "updated_at": "2026-11-21T04:00:00.000Z" }]
  }
}
```

- **Identity**：名字、人格、目标。进主循环提示词。
- **Tenets**：每条带 id、类型、来源会话、时间戳。
  - `invariant`（不变量）：必须带至少一条 `deny` 规则（权限规则语法，如 `shell(rm *)`、`write_file(**/.env)`），编译进规则层，违反时在工具调用前由代码拦截，不靠模型自觉。
  - `prior`（偏好）：柔性偏好，只进提示词，不带 deny 规则。
  - 每条可开关（`enabled`：关掉的不参与编译与提示词注入，文件里留着）。
- **memory_index**：只记“哪个记忆文件、有几条、上次同步时间”，不复制记忆正文；路径只记相对 home 的相对路径。
- **charter**（角色契约，GROK-2）：与 Tenet 并列的一份书面合同——负责什么（`own`）、信息来源（`sources`，1–10 条）、输出格式（`output`）、审批门（`approval`）、停下条件（`stop`），每项 1–1000 字，五项齐全有效才算一份契约。建团队接单须有完整 Charter（缺了直接拒绝）；交付时配 verifier 抽查（`charter_valid` 行，只核说法不验语义）。命令见下文“命令”一节的 `soul charter` 三行，详见 `docs/team.md`。

当前运行用哪个 Soul：`config.json` 的 `soul.agent`（默认 `default`），或环境变量 `NYRA_SOUL_AGENT`。没有 Soul 文件时一切如旧（零影响）。

## 不变量是怎么拦住人的

比 Hello Minds 硬一档：对方的 Invariant 靠模型“认知失调后不遵守”（提示词层自律）；Nyra 把 invariant 编译进权限规则层（deny > ask > allow），执行在三处，不在提示词里：

1. `checkApproval`（`src/tools.ts`）：禁做档在用户自定义权限规则之前拦——自定义 allow 规则打不开它，幂等重试绕不过它，即使已批准也不放行。Soul 文件损坏时 fail-closed：写操作全部拦截。
2. `reviewToolCall`（`src/reviewer.ts`）：独立审查层开启且工具在被审集内时，invariant 命中直接 BLOCK（`rule: soul-invariant`），不进模型审查、不看 Custom Rules。
3. 提示词里只列“硬约束（由代码强制执行）”，让模型知道为什么会被拦——执行本身不依赖模型。

拦截记两处：运行事件 `soul_invariant_blocked`（agent、tenet id、工具、规则原文）与审计 `~/.nyra/soul-audit.jsonl`。

## 命令

```bash
nyra soul show [agent]          # 看某个 agent 的 Soul（默认 default；看的时候顺手同步记忆索引）
nyra soul status                # 列出已有的 Soul（各有几条 Tenet、开着几条、有没有规则警告）
nyra soul list                  # 只列 agent 名
nyra soul init [agent] [--name 名字] [--persona 人格] [--goal 目标]
nyra soul add --kind invariant|prior --text "正文" [--deny "规则" ...] [--session 会话 id] [--yes]
nyra soul remove <tenet id> [--yes]
nyra soul enable <tenet id> / disable <tenet id>
nyra soul edit <tenet id> [--text "新正文"] [--deny "规则" ...]
nyra soul export [agent] [--out <路径>]   # 导出 JSON（0600，默认不上传）
nyra soul import <路径> [--agent <名字>] [--yes]  # 导入（替换同名文件，须确认）
nyra soul charter set <agent> --own "负责什么" --sources "来源1、来源2" --output "输出格式" --approval "审批门" --stop "停下条件" [--yes]
nyra soul charter show [agent]          # 看某个 agent 的角色契约
nyra soul charter clear <agent> [--yes]  # 清掉角色契约（清掉后该 agent 不能再接团队单）
```

- **查看 Tenets 是一等命令**：`nyra soul show` 直接看全部 Tenet（id、类型、开/关、正文、deny 规则、来源会话、创建时间），不用翻 JSON。
- **增删改要确认**：交互问一次，或 `--yes`；改动记进 `soul-audit.jsonl`（谁批准的、动了哪条、动完剩几条）与证据链（`soul_tenet_added` / `soul_tenet_removed` / `soul_tenet_changed` 事件）。
- **可关、可删、可导出，默认不上传**：每条 Tenet 可开关、可删；整个 Soul 可导出成 JSON；Soul 文件只在用户本机，不上传。

## 记忆索引与 Tenet 索引

- `rebuildSoulMemoryIndex`：`nyra soul show` 时自动同步（内容不变不重写文件）。
- `src/memory.ts` 的 `buildTenetIndex` / `findTenetById`：Tenet 按 id 全局可查（属于哪个 Soul）；索引是派生的（读 Soul 文件现算），损坏的 Soul 跳过。

## 已知局限

- Soul 的 agent 名只认小写字母开头、字母数字/下划线/连字符（最长 32 字）；多 agent 的 Soul 切换靠 `soul.agent` 配置或 `NYRA_SOUL_AGENT`，没有自动发现。
- invariant 的 deny 规则是权限规则语法（工具名 + 通配），表达不了“这句话的意思是删除”这种语义判断——语义层面的拦截仍靠独立审查层。
- 手改 Soul 文件改坏了某条 deny 规则时，编译跳过它并在 `soul show` / `soul status` 里亮 warning；写入路径（add/edit/import）会直接拒绝坏规则，不让它进文件。
- 真机验证：只在临时 home 与假审查 runner 上验过；真实 Bot（缺口 42）接 Soul 是下一批的事，本批只做身份层本身。
- Charter（角色契约）写得再好模型也可能不遵守：抽查是确定性启发式检查、只核说法不验语义，内容对错仍由 verifier + 人批负责（详见 `docs/team.md`）。
