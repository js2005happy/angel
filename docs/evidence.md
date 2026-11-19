# 证据链（P1-2）

长任务跑完后，“做完了”不能只凭模型一句话。证据链把一次运行的三个环节钉在一起，事后能独立复核：

```
工具调用（events.jsonl） → 产物（state.json 的 changed_files + file_hashes） → 校验结果（state.json 的 verify_result）
```

## 落盘位置

每次运行的记录都在 `~/.nyra/runs/<运行 ID>/`：

- `state.json`：运行状态、`changed_files`（本轮改过的文件，相对工作目录）、`file_hashes`（运行结束时每个改动文件的 sha256）、`verify_result`（`--verify` 的退出码、是否通过、尝试次数、`tests_modified`）。
- `events.jsonl`：每行一个事件。`tool_start` / `tool_result` 带 `args_hash`（P1-4 的幂等键）；`verify_started` / `verify_result` 记录验证命令的执行；中断可能截断最后一行，读的时候跳过损坏行。

复用的是现有 `src/evidence.ts` / `src/artifacts.ts` / `src/runs.ts` / `--verify`，没有另发明存储格式。`file_hashes` 在运行的成功路径与失败路径都会记（读不到的文件跳过，失败不影响运行本身）。

## 独立复核

```bash
nyra evidence verify <运行 ID>
```

退出码：`0` 通过；`4` 链不完整（与 `--verify` 未通过同码 `EXIT_VERIFY`）；`1` 运行不存在或记录损坏；`2` 用法错误。

五项检查：

| 检查 | 通过条件 | 失败说明 |
| --- | --- | --- |
| verify-result | `verify_result.passed === true`（或运行状态本身就是 `verified`） | 未验证 / 验证失败 |
| tool-calls-closed | 每个 `tool_start` 都有对应的 `tool_result` | 有调用没结果（中断、崩溃） |
| artifacts-present | `changed_files` 里的文件都还在 | 产物丢失 |
| artifacts-hash | 每个产物的当前 sha256 与 `file_hashes` 一致 | 产物被改过 |
| tests-modified | `verify_result.tests_modified` 为真时只记一条警告 | 不判失败，只提醒“测试本身被改过，验证结果要打折” |

输出是可读的逐项报告，通过/失败一目了然。无证据的完成声明直接红——与 P1-1（未验证不得宣称“已完成”）的降级逻辑一致：模型说“做完了”但没有校验结果，复核不通过。

## 诚实边界

- 复核**不重跑验证命令**：它只核对记录本身是否自洽、产物是否还在且没被改过。验证本身是 `--verify` 的事。
- 哈希只证明“运行结束时文件是这个内容”，不证明内容正确。写错了但验证通过，链照样是完整的——错的是验证命令本身。
- 旧运行（0.5.2 之前）没有 `file_hashes`，哈希检查会失败并明说原因（“运行记录中没有文件哈希”），而不是静默通过。
- `events.jsonl` 里 `args_hash` 是单向指纹（见 `docs/resume.md`），脱敏时豁免，不会因为“像密钥”被毁掉。
