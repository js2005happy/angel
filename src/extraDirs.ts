// src/extraDirs.ts — 额外可写根（对齐 Codex 的 `--add-dir`）。
//
// 场景：项目要写 `~/go/pkg/mod`、`/tmp/build`、同级仓库这些工作目录之外的地方。
// 现在只有两条路——退出沙箱（--sandbox local）或什么也写不了。`--add-dir` 给第三条：
// **把这些目录显式加进可写集合**，沙箱与路径校验同时放开，其余限制不变。
//
// 纪律：
//   - 只接受绝对路径且必须存在且是目录——相对路径歧义大，不存在说明写错了
//   - **拒绝把工作目录的祖先/根目录加进来**（加 `/` 等于关掉 containment）
//   - 结果去重、排序，便于测试与展示
//   - 纯函数（存在性检查由调用方传 false 跳过），便于单测
import { resolve, sep } from "node:path";
import { statSync } from "node:fs";

export interface ExtraDirResult {
  ok: string[];
  rejected: { input: string; reason: string }[];
}

const isAbsolutePath = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);

/**
 * 校验并规整 `--add-dir` 传入的目录列表。
 *
 * @param inputs 原始输入（可能重复、含空项）
 * @param opts.workdir 工作目录，用于拒绝祖先/根
 * @param opts.checkExists 是否检查存在性（默认 true；测试可传 false）
 */
export function resolveExtraDirs(
  inputs: readonly string[],
  opts: { workdir?: string; checkExists?: boolean } = {},
): ExtraDirResult {
  const ok: string[] = [];
  const rejected: { input: string; reason: string }[] = [];
  const seen = new Set<string>();
  const workdir = opts.workdir ? resolve(opts.workdir) : null;
  const checkExists = opts.checkExists !== false;

  for (const raw of inputs) {
    const input = typeof raw === "string" ? raw.trim() : "";
    if (!input) {
      rejected.push({ input: String(raw), reason: "空路径" });
      continue;
    }
    if (!isAbsolutePath(input)) {
      rejected.push({ input, reason: "必须是绝对路径（相对路径含义不明确）" });
      continue;
    }
    const abs = resolve(input);
    // 拒绝根目录与工作目录的祖先：加进来等于把整个磁盘设为可写
    if (abs === resolve("/") || /^[A-Za-z]:\\?$/.test(abs)) {
      rejected.push({ input, reason: "不能把根目录设为额外可写" });
      continue;
    }
    if (workdir && (abs === workdir || workdir.startsWith(abs + sep))) {
      rejected.push({ input, reason: "这是工作目录本身或其上级，已在可写范围或会放开整棵上级目录" });
      continue;
    }
    if (checkExists) {
      try {
        const st = statSync(abs);
        if (!st.isDirectory()) {
          rejected.push({ input, reason: "不是目录" });
          continue;
        }
      } catch {
        rejected.push({ input, reason: "目录不存在" });
        continue;
      }
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    ok.push(abs);
  }
  return { ok: ok.sort(), rejected };
}

/** 某个绝对路径是否落在额外可写根之下（含根本身）。 */
export function isUnderExtraDir(absPath: string, extraDirs: readonly string[]): string | null {
  const target = resolve(absPath);
  for (const dir of extraDirs) {
    const root = resolve(dir);
    if (target === root || target.startsWith(root + sep)) return root;
  }
  return null;
}

/** 一行摘要（doctor / 启动提示用）。 */
export function describeExtraDirs(extraDirs: readonly string[]): string {
  return extraDirs.length ? `额外可写根：${extraDirs.join("、")}` : "额外可写根：（无）";
}
