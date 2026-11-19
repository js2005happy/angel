# 长期记忆：检索与删除（缺口 1 + 缺口 2）

> 2026-11-20，P3 第一批。只学能力、不抄实现：接口语义学 EverOS
> （按会话删、按记忆 ID 删、进行中会话保护、删后汇报数量）与 Meta AI
> （用户能问它记得什么、逐条要求忘记），实现是 Nyra 自己的 Node
> 存储，不引回 Python/LanceDB。

## 存储：MEMORY.md 不动，结构化信息进 sidecar 索引

- `MEMORY.md` 仍是纯文本、一行一条，手工能改；`memory_append` 写
  的行是 `- [YYYY-MM-DD HH:MM] 正文`。
- 结构化信息（**id + 来源会话 + 时间戳**）存在同目录的 sidecar
  索引文件 `<记忆文件>.index.json`（`src/memory.ts` 的
  `syncMemoryIndex`）：行内容没变则 id 不变，新行分配新 id
  （`mem_` + 12 位十六进制），删掉的行从索引里消失。
- 索引是派生的：丢了或损坏就按当前文件重建，不丢记忆正文。
  `memory_append` 写入时把当前会话 id 记成新行的来源会话；
  手工写 / 旧行 / 导入的行的来源会话为 null。

## 作用域（owner）

记忆文件本身定 owner：全局 `MEMORY.md` 是 `global`，群机器人
`<home>/groups/<room>/bots/<bot>/MEMORY.md` 是 `bot:<room>/<bot>`。
检索与删除都先核 owner，跨 owner 不读不删（删错 owner 的目标只
跳过、不删、不抛错，汇报里列出来）。

## 缺口 1：检索（BM25 接进主循环）

- `src/memory.ts` 的 `searchMemoryEntries` 复用 `src/knowledge.ts`
  已有的 BM25（`tokenize` + `scoreBm25`，与知识库同一套公式），
  作用域过滤：owner 不符直接拒绝，`session_id` 有值时只看该会话
  写的记忆。**向量检索另算，本批不做。**
- 工具 `memory_search`（只读，不需审批）：`query` 必填，
  `limit` 默认 5，`session_id` / `owner` 可选。每条结果附来源
  （记忆 id、来源会话、时间戳、文件行号），与证据链同口径。
- 主循环：`Agent.buildSystemPrompt` 用 `buildMemorySection`——
  有命中时只注入命中的条目（附来源，标“历史记忆，需复核”），
  替代无条件读最后 40 行；无命中时回落到最后 40 行；记忆为空
  时不加任何东西。压缩后重读（`postCompactReReadNote`）仍读
  最后 40 行，不动。
- 与 #58 的 `runRecall`（`src/runRecall.ts`，runs/ 回忆）互补、
  不是重复：一个是 MEMORY.md 里的事实，一个是上次同类任务的
  结论，两边都留；检索结果的注入风格参照了它的“历史，需复核”标注。
- CLI：`nyra memory search <关键词> [--limit N] [--session <会话 id>]`。

## 缺口 2：删除与控制

- 工具 `memory_forget` / `memory_delete`（同义，两个名字都留着：
  别家 MCP 叫 `forget_session`，用户口语也常说“忘记这条”）：
  `ids`（记忆 id 列表）或 `session_id`（删掉该会话写下的全部记忆）
  至少给一个，`owner` 与 `reason` 可选。
- **审批与 `write_file` 同级**：进 `MUTATING_TOOLS`，走
  `checkApproval`（readonly 拒、auto 非交互拒、权限规则 deny 拒、
  终端/`approveFn` 逐项批）；审批摘要先列出要删的条目与删后剩余
  数，让用户看一眼再批。也进 `HOOKED_TOOLS`（Pre/PostToolUse）
  与 `SESSION_FILE_TOOLS`（“始终允许”按记忆文件记）。
- **进行中会话拒绝**：目标里有进行中会话写的记忆时整批拒绝，
  一条都不删（工具侧以当前会话 id 为准；网关侧以正在跑的 live
  会话为准）。这是 EverOS 的 503 保护在 Nyra 的对位。
- **删除本身进证据链**：删了什么（id + 正文 + 来源会话 +
  时间戳）、谁批准的（终端审批 / 网关审批卡 / full 模式已授权）、
  删后数量（删了 N 条、剩 M 条），写进 `EvidenceStore`
  （kind `memory_delete`）。网关与 CLI 的删除同样落证据。
- 失败重试：`verifyWriteApplied` 能核查删除是否已生效（目标 id
  已不在记忆里），首次调用失败但实际已删时不再重复删。
- 网关：`DELETE /api/memory`（body `{scope, room?, bot?, ids? |
  session_id?, revision?}`；`revision` 有值时走 CAS——对不上
  409，一条都不删，复用 `memoryBrowser.ts` 的思路；进行中会话
  409；owner 不符的目标跳过不删）。信任级别与已有的
  `POST /api/memory`（整文件保存）一致：token 鉴权、用户主动
  发起，不另设审批；agent 工具侧的删除仍走 `checkApproval`。
  响应：`{deleted, deleted_ids, remaining, skipped, not_found}`。
- CLI：`nyra memory forget <记忆 id...> [--session <会话 id>]
  [--yes]`——缺省先列出要删的条目再问一次，`--yes` 跳过确认。

## 诚实边界

- 记忆 id 是 sidecar 索引分配的：索引丢失重建后 id 会变，删除时
  以当次查到的 id 为准，不要把 id 当永久标识存到别处。
- BM25 只按词面匹配：同义词、改述过的事实可能查不到；查不到时
  主循环回落到最后 40 行，不是“记忆里没有”。
- 索引文件与 MEMORY.md 是两份文件：外部直接改 MEMORY.md 后，
  下一次检索/删除时索引才同步，期间 id 可能与旧索引对不上——
  删除前先用 `memory_search` 查当次的 id。
- 网关 DELETE 与 CLI forget 是用户主动发起的直接调用，不经过
  agent 的审批卡；只有 agent 工具（`memory_forget` /
  `memory_delete`）走审批。
