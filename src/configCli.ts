// src/configCli.ts — `nyra config export|import`。
//
//   nyra config export [--out <file>] [--include-secrets]
//   nyra config import <file> [--dry-run] [--allow-dangerous]
//
// 退出码：0 成功；1 导入被拒绝/写入失败；2 用法错误。
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig, saveConfig } from "./config.ts";
import { t } from "./i18n.ts";
import { exportConfig, previewImport, formatImportPreview } from "./configTransfer.ts";

interface Args {
  sub?: string;
  file?: string;
  out: string | null;
  includeSecrets: boolean;
  dryRun: boolean;
  allowDangerous: boolean;
}

function parse(argv: string[]): Args {
  const a: Args = { out: null, includeSecrets: false, dryRun: false, allowDangerous: false };
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--out") a.out = argv[++i] ?? null;
    else if (t === "--include-secrets") a.includeSecrets = true;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--allow-dangerous") a.allowDangerous = true;
    else if (t.startsWith("-")) { /* 未知 flag 忽略，交给用法提示 */ }
    else pos.push(t);
  }
  a.sub = pos[0];
  a.file = pos[1];
  return a;
}

export function handleConfig(argv: string[], home: string): number {
  const args = parse(argv);
  const config = loadConfig(home);

  if (args.sub === "export") {
    const { payload, redacted } = exportConfig(config, { includeSecrets: args.includeSecrets });
    const json = JSON.stringify(payload, null, 2) + "\n";
    if (args.out) {
      try {
        writeFileSync(args.out, json, "utf-8");
      } catch (err) {
        process.stderr.write(`写文件失败：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      process.stdout.write(t("config.exportedTo", { file: args.out }) + "\n");
    } else {
      process.stdout.write(json);
    }
    if (redacted.length) {
      process.stderr.write(t("config.redactedNote", { n: redacted.length, list: redacted.join("、") }) + "\n");
    }
    return 0;
  }

  if (args.sub === "import") {
    if (!args.file) {
      process.stderr.write("用法：nyra config import <file> [--dry-run] [--allow-dangerous]\n");
      return 2;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(args.file, "utf-8"));
    } catch (err) {
      process.stderr.write(`读取/解析失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const preview = previewImport(raw, config, { allowDangerous: args.allowDangerous });
    process.stdout.write(formatImportPreview(preview, args.file) + "\n");
    if (!preview.ok) return 1;
    if (args.dryRun) {
      process.stdout.write(t("config.dryRun") + "\n");
      return 0;
    }
    try {
      saveConfig(home, preview.merged);
    } catch (err) {
      process.stderr.write(`写入配置失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    process.stdout.write(t("config.imported") + "\n");
    return 0;
  }

  process.stdout.write(
    "用法：\n" +
      "  nyra config export [--out <file>] [--include-secrets]\n" +
      "  nyra config import <file> [--dry-run] [--allow-dangerous]\n" +
      "\n" +
      "导出默认剔除密钥；导入默认忽略会削弱安全的字段（沙箱/权限/成本上限等），需 --allow-dangerous。\n",
  );
  return args.sub ? 2 : 0;
}
