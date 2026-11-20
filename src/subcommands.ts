// src/subcommands.ts — 子命令清单（**单一事实源**）。
//
// 为什么单独成文件：这份清单被三处消费——
//   1. `cli.ts` 用它判断第一个参数是不是子命令
//   2. `docCheck` 用它校验文档（D1/D2）
//   3. 测试与文档索引（docs/COMMANDS.md）
//
// 以前它写在 cli.ts 里，于是测试只能靠正则去源码里抠——能跑但脆（改个格式就断）。
// 挪出来后，任何一处用它都拿同一份数组，加子命令时不可能漏改某处。

export const SUBCOMMANDS: readonly string[] = [
  // 运行与结论
  "verdict", "guard", "redlines", "evidence", "restore", "timeline", "replay",
  // 成本与用量
  "cost", "savings", "stats",
  // 配置与开关
  "config", "features", "tools", "models", "reviewer", "verifier", "account",
  // 记忆与复用
  "recall", "memory", "style", "skills", "bughunt", "market",
  // 后台与协作
  "ui", "gw", "schedule", "events", "task", "review", "mail-inbox", "responsibility", "bot",
  // 扩展与集成
  "plugin", "creator", "kb", "hooks", "permissions", "eigenflux", "gmail", "shopify", "slack", "connector", "mcp", "peer", "voice", "export", "media",
  // 自检与运维
  "doctor", "status", "setup", "vault",
] as const;

/** 供 `Set` 用法与文档校验共用。 */
export function subcommandSet(): Set<string> {
  return new Set(SUBCOMMANDS);
}
