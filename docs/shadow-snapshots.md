# 影子快照 + 文件与会话联合回滚（缺口 9）

改错了一键回到精确的“改动前一刻”，而不是手动拼凑。这是 Nyra 的检查点
（`/undo`、`/rewind`）的上一层：检查点是按轮快照，影子快照是**每次批准
写操作前**快照。

## 什么时候拍快照

`write_file`、`edit_file`、`apply_patch`、`plan` 四个写文件工具，在**审批
通过后、真正写入前**各拍一次（`src/tools.ts` 的影子快照钩子）。拍的内容：

- 目标文件的改前内容（不存在即记“新建”，恢复时删掉）；
- 当时整段 live 会话（过 `scrubSecrets`，不存明文凭据）；
- 该次工具调用的引用（工具名、目标、摘要），恢复后重新提出供重跑、修改或忽略；
- 已持久化对话的水位（`ConversationStore` 最后一条消息 id），恢复时据此截断存档。

审批不过、幂等重试（首次调用已拍过）不拍。快照失败绝不拦住已批准的写操作，
只记一次 `shadow_snapshot_failed` 事件——快照是安全网，不是门。

## 影子 Git 仓优先，Git 不可用退回文件快照

- 影子仓在 `~/.nyra/shadow/<工作目录指纹>/repo`，是独立 Git 仓库，**不碰
  用户自己的 Git 历史**；每次快照一次提交（含改前文件 + 会话 JSON + 记录 JSON）。
- 本机没有 Git，或 Git 写入失败时，退回同一目录下的文件快照
  (`snapshots/<id>/`)，恢复能力相同，并在快照记录里写明原因；文件后端时
  工具结果会追加一句提示（如“本机未安装 Git，已退回文件快照”），让模型转
  告用户——**不静默失败**。
- 远端写（backend）与工作目录外的写只拍会话（文件不在本地磁盘上，拍不到）。

## 恢复：`nyra restore` 与 `/restore`

```text
nyra restore                                  列出本工作目录的影子快照（序号 1 为最新）
nyra restore 1                                恢复最新快照（文件 + 会话一起）
nyra restore <序号或 id> --mode files         只恢复文件
nyra restore <序号或 id> --mode session       只恢复会话
nyra restore <序号或 id> --mode both          文件 + 会话一起（默认）
```

REPL 里是 `/restore`、`/restore 1`、`/restore 1 files`（模式直接跟在后面）。
恢复后会打印原工具调用（`原工具调用：write_file a.txt —— 可重跑、修改后
重跑，或忽略`），并往对话里追加一条恢复记录，模型不要假设此前改动仍存在。
REPL 里内存会话直接回到快照时刻；`nyra restore`（无 live agent）还会把会话
文件也写回快照时刻，否则 `--resume` 会读回已删的消息。

## 恢复是 fail-closed 的

恢复前全量校验，任一步失败都不改任何文件与会话：

- 快照内容 sha 必须与记录一致（git 后端从提交里读，文件后端读副本）；
- 目标必须在工作目录内、不是符号链接；
- 会话水位消息必须属于本会话；
- 会话快照损坏、提交缺失、副本被改过，恢复直接中止并说明原因。

## 回滚进证据链

每次恢复记两处：

- `runs.ts` 的 `restore` 事件（`snapshot_id`、`triggered_by`、`mode`、
  `files`（逗号分隔的相对路径）、`messages_deleted`、`messages_kept`），
  优先追加到该会话最新的运行记录；该会话尚无运行时新建一条 `restore`
  运行记录，保证 `nyra evidence` 能看到；
- 影子目录的 `restores.jsonl`（同字段 + 后端 + 时间戳）。

快照本身也记 `snapshot` 事件（`snapshot_id`、`tool`、`backend`、`files`）。
别家的回滚只管“回去了”，Nyra 管“回去得可审计”。

## 边界

- 单文件超过 2 MiB 不拍文件内容（与 `CheckpointStore` 同限），只拍会话与
  工具调用，记录里写明原因；恢复时该文件不在恢复范围内。
- 快照只覆盖 UTF-8 文本写操作（上述四个工具都写文本）；二进制内容经 Git
  读回时无法保证字节一致，sha 校验不过会中止恢复，不会静默写坏文件。
- `memory_append` / `save_skill` 写的是 `~/.nyra` 下的记忆与技能，不是工作
  目录文件，不在影子快照范围内（改动记忆请走 `nyra memory forget`，同样进
  证据链）。
- 快照不自动清理：每次只存目标文件的改前内容，不存整个项目，增长与写操作
  量成正比；索引是追加式 `index.jsonl`，损坏行跳过，不丢其余快照。
- 桌面端（`desktop/`）不参与：影子快照是终端 / 网关共用的本地能力。
