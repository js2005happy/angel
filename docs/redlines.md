# 上线红线自检：`nyra redlines`

> 回答「**这个配置能不能上生产**」。三层判定：`ok`（已设好）/ `warn`（缺省可接受但长任务前该补）/ `fail`（明确危险，别上）。

```bash
nyra redlines            # 人看：分级清单 + 修复建议
nyra redlines --json      # 机器看：稳定短码 + 布尔 + 计数（给 CI）
```

退出码：没有 `fail` → 0；有 `fail` → 非 0（`warn` 需人工确认，不影响退出码）。

## 机器可读输出

```json
{
  "schema_version": 1,
  "ok": false,
  "verdict": "…",
  "has_fail": true,
  "has_warn": true,
  "counts": { "ok": 3, "warn": 4, "fail": 1 },
  "findings": [
    { "code": "sandbox-danger-mode", "level": "fail", "title": "…", "detail": "…", "fix": "…" }
  ]
}
```

| 字段 | 为什么这样设计 |
|---|---|
| `code` | **稳定短码**，CI 靠它做白名单放行（不要匹配中文文案） |
| `has_fail` / `has_warn` | 等级映射成布尔，CI 不用自己数字符串——自定义判定越少，误判越少 |
| `counts` | 一眼看分布；与 `findings` 逐条一致（有测试锁住） |
| `fix: null` | 没给修法时是 `null` 而不是丢字段，JSON 结构稳定 |

契约同 `verdict` / `savings` / `cost` / `stats`：**只加字段、不改名、不删字段**。

## CI 用法

```bash
# 只拦 fail，放行指定 code
nyra redlines --json | jq -e '.has_fail == false'

# 想看等级分布
nyra redlines --json | jq '.counts'
```

## 相关的体检

- `nyra status` —— 诊断：坏配置、不可用沙箱、被忽略的权限、永不匹配的 hook matcher
- `nyra verdict` —— 一条结论：这次跑得值不值（红线 + 省钱 + 回忆 + 文档）
- `nyra guard` —— 门禁形态：red 时退出码 2
