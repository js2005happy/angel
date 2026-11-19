# 配置速查表（由脚本生成，勿手改）

> 本文件由 `scripts/gen-config-map.ts` 从 `src/configExplain.ts` 生成。
> 改了配置项请改代码，然后重新生成；`tests/node/test-config-map-sync.test.ts` 会检查两者是否一致。

查当前生效值：`nyra config explain [能力名]`

| 能力 | 能改它的键 | 默认值 | 说明 |
|---|---|---|---|
| `tool_search` | `features.tool_search`<br>`tool_search.enabled`<br>`NYRA_LAZY_TOOLS`<br>`--enable-feature tool_search` | off | 未开启：MCP 工具超过 8 个时仍会自动开启 |
| `run_recall` | `features.run_recall`<br>`--disable-feature run_recall`<br>`redlines.thresholds.recallMaxAgeDays` | on | 已开启；过期天数由 redlines.thresholds.recallMaxAgeDays 决定（默认 30） |
| `cost_cap` | `max_cost_usd`<br>`--max-cost` | off | 未设上限：长任务可能无限烧钱 |
| `aux_model_routing` | `compact_model`<br>`delegate_model` | off | 未配置：压缩与子任务都用主模型（成本更高） |
| `reasoning_effort` | `reasoning_effort`<br>`verbosity` | provider 默认 | 未配置：不发这两个字段（payload 与默认一致） |
| `extra_writable_dirs` | `extra_writable_dirs`<br>`--add-dir` | none | 只有工作目录可写 |
| `deny_read_globs` | `deny_read_globs` | off | 未配置：敏感文件（.env / secrets）可被读取并发给模型 |
| `sandbox` | `sandbox`<br>`sandbox_mode`<br>`--sandbox` | auto | auto：Linux 用 bwrap、macOS 用 seatbelt（需显式 --sandbox seatbelt） |

## 生效优先级（通用）

```
CLI 覆盖  >  config.json  >  环境变量（仅个别能力）  >  默认值
```

- 环境变量目前只有 `NYRA_LAZY_TOOLS=0`（一票否决延迟加载）与 `NYRA_ALLOW_PROTECTED_WRITES`、`NYRA_ALLOW_READ_OUTSIDE_WORKDIR` 这类显式放开开关
- `--enable-feature` / `--disable-feature` 对同名开关**disable 优先**
- 想确认某次运行到底用了什么：`nyra config explain <能力>`