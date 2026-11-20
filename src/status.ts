// src/status.ts — /status 诊断清单（缺口 19，学 Claude Code 2.1.327 的 /status）。
//
// 只读：只检查、不改任何状态、不 spawn、不联网。列出的是"坏了但静默失效"的配置：
// 损坏的 agent/skill/command/output-style 文件、按键绑定错误、不可用沙箱、
// 被忽略的权限设置、永不匹配的 hook matcher。
// Nyra 目前没有 output-style 与按键绑定这两个功能（见下面对应检查的说明）：
// 有用户自己放的文件/配置就校验，没有就报"未配置"、不编造问题。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFile, canonicalSkillDirs } from "./skills.ts";
import { parseRules, normalizeToolName, lintRules } from "./permissionRules.ts";
import { getSandboxStatus } from "./sandbox.ts";
import { listHookEntries, listUnknownHookEvents, matchHookTool, HOOK_EVENTS } from "./hooks.ts";
import { TOOL_SCHEMAS } from "./tools.ts";

export type StatusLevel = "ok" | "info" | "warn" | "error";

export interface StatusCheck {
  id: string;
  category: string;
  level: StatusLevel;
  message: string;
  detail?: string;
  fix?: string;
}

export interface StatusReport {
  checks: StatusCheck[];
  errors: number;
  warnings: number;
  ok: boolean;
}

/** REPL 已有的斜杠命令（/status 校验按键绑定目标时用；新增命令要同步这里）。 */
export const KNOWN_REPL_COMMANDS: readonly string[] = [
  "help", "exit", "clear", "context", "compact", "mode", "model", "lang", "pet",
  "creator", "commands", "undo", "rewind", "restore", "rewind-msg", "rewind-edit",
  "rewind-fork", "stats", "status",
];

/**
 * 已知工具名：TOOL_SCHEMAS 的函数名 + executeTool 里有、schema 表里没有的
 * 几个（memory_forget/memory_delete 与 poppy_*）。/status 校验权限规则与
 * hook matcher 时用；工具新增后 schema 表会自动带上，extras 只补漏网的。
 */
const TOOL_NAME_EXTRAS: readonly string[] = [
  "memory_forget", "memory_delete", "poppy_discover", "poppy_identity_check",
  "poppy_permission_check", "search_tools", "mcp",
];

export function knownToolNames(): Set<string> {
  const names = new Set<string>(TOOL_NAME_EXTRAS);
  for (const s of TOOL_SCHEMAS) {
    const fn = (s as { function?: { name?: string } }).function;
    if (fn?.name) names.add(fn.name);
  }
  return names;
}

function readConfigJson(home: string): { config: Record<string, unknown> | null; error?: string } {
  const path = join(home, "config.json");
  if (!existsSync(path)) return { config: null };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config: null, error: "config.json 顶层不是对象" };
    return { config: raw as Record<string, unknown> };
  } catch (err: unknown) {
    return { config: null, error: `config.json 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 轻量 frontmatter 校验：文件须以 --- 开头、有闭合 ---、且含 name: 行。 */
function frontmatterNameError(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    return `读不到：${err instanceof Error ? err.message : String(err)}`;
  }
  if (!text.trim()) return "文件为空";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return "缺少 frontmatter（首行不是 ---）";
  const closing = lines.indexOf("---", 1);
  if (closing === -1) return "frontmatter 未闭合（缺少第二个 ---）";
  const hasName = lines.slice(1, closing).some((l) => /^name\s*:/.test(l.trim()));
  if (!hasName) return "frontmatter 缺少 name";
  return null;
}

function mdFiles(dir: string): string[] {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * 缺口 19：跑全部诊断。纯只读（只读文件、只解析配置），不 spawn、不写盘。
 * home = ~/.nyra，workdir = 当前工作目录。
 */
export function runStatusChecks(opts: { home: string; workdir: string; config?: Record<string, unknown> | null }): StatusReport {
  const { home, workdir } = opts;
  const checks: StatusCheck[] = [];
  const { config, error: configError } = opts.config !== undefined
    ? { config: opts.config, error: undefined as string | undefined }
    : readConfigJson(home);
  if (configError) {
    checks.push({ id: "config", category: "config", level: "error", message: configError, fix: "修好 ~/.nyra/config.json 的 JSON 语法，其余检查按默认值继续" });
  }

  // 1. 技能文件：parseSkillFile 抛错 = 损坏（缺 frontmatter / 缺 name）。
  {
    const dirs = canonicalSkillDirs(workdir, home);
    let total = 0;
    let broken = 0;
    for (const dir of dirs) {
      for (const path of mdFiles(dir)) {
        total += 1;
        try {
          parseSkillFile(path);
        } catch (err: unknown) {
          broken += 1;
          checks.push({
            id: `skill:${path}`, category: "skills", level: "error",
            message: `损坏的技能文件：${path}`,
            detail: err instanceof Error ? err.message : String(err),
            fix: "补上 frontmatter（---、name:、description:、---）或删掉该文件",
          });
        }
      }
    }
    if (broken === 0) {
      checks.push({ id: "skills", category: "skills", level: "ok", message: total ? `技能文件 ${total} 个，全部可解析` : "未配置技能文件" });
    }
  }

  // 2. agent 文件：Nyra 目前没有内置的 subagent 定义文件（delegate 是动态委派），
  // 但用户如果在 ~/.nyra/agents/ 或 <workdir>/.nyra/agents/ 放了 .md，就按
  // frontmatter 校验；没有就报"未配置"，不编造问题。
  {
    const dirs = [join(workdir, ".nyra", "agents"), join(home, "agents")];
    const files = dirs.flatMap(mdFiles);
    if (!files.length) {
      checks.push({ id: "agents", category: "agents", level: "info", message: "未配置 agent 文件（Nyra 暂无内置 subagent 定义文件，delegate 为动态委派）" });
    } else {
      let broken = 0;
      for (const path of files) {
        const err = frontmatterNameError(path);
        if (err) {
          broken += 1;
          checks.push({ id: `agent:${path}`, category: "agents", level: "error", message: `损坏的 agent 文件：${path}`, detail: err, fix: "补上 frontmatter（含 name:）或删掉该文件" });
        }
      }
      if (broken === 0) checks.push({ id: "agents", category: "agents", level: "ok", message: `agent 文件 ${files.length} 个，全部可解析` });
    }
  }

  // 3. 自定义命令文件：读不到或空文件 = 损坏。
  {
    const dirs = [join(workdir, ".nyra", "commands"), join(home, "commands")];
    const files = dirs.flatMap(mdFiles);
    if (!files.length) {
      checks.push({ id: "commands", category: "commands", level: "info", message: "未配置自定义命令" });
    } else {
      let broken = 0;
      for (const path of files) {
        let text = "";
        try {
          text = readFileSync(path, "utf-8");
        } catch (err: unknown) {
          broken += 1;
          checks.push({ id: `command:${path}`, category: "commands", level: "error", message: `损坏的命令文件：${path}`, detail: `读不到：${err instanceof Error ? err.message : String(err)}` });
          continue;
        }
        if (!text.trim()) {
          broken += 1;
          checks.push({ id: `command:${path}`, category: "commands", level: "error", message: `损坏的命令文件：${path}`, detail: "文件为空", fix: "写上命令内容或删掉该文件" });
        }
      }
      if (broken === 0) checks.push({ id: "commands", category: "commands", level: "ok", message: `自定义命令 ${files.length} 个，全部可读` });
    }
  }

  // 4. output-style 文件：Nyra 目前没有该功能；有文件就校验，没有报"未配置"。
  {
    const dirs = [join(workdir, ".nyra", "output-styles"), join(home, "output-styles")];
    const files = dirs.flatMap(mdFiles);
    if (!files.length) {
      checks.push({ id: "output-styles", category: "output-styles", level: "info", message: "未配置 output-style 文件（Nyra 暂无该概念）" });
    } else {
      let broken = 0;
      for (const path of files) {
        const err = frontmatterNameError(path);
        if (err) {
          broken += 1;
          checks.push({ id: `output-style:${path}`, category: "output-styles", level: "error", message: `损坏的 output-style 文件：${path}`, detail: err, fix: "补上 frontmatter（含 name:）或删掉该文件" });
        }
      }
      if (broken === 0) checks.push({ id: "output-styles", category: "output-styles", level: "ok", message: `output-style 文件 ${files.length} 个，全部可解析` });
    }
  }

  // 5. 按键绑定：Nyra 未内置按键绑定配置；config.json 里写了 keybindings 才校验，
  // 动作必须是已有的 REPL 斜杠命令（不带 /），否则就是"绑定了不存在的命令"。
  {
    const bindings = config?.keybindings;
    if (bindings === undefined || bindings === null) {
      checks.push({ id: "keybindings", category: "keybindings", level: "info", message: "未配置按键绑定（Nyra 未内置按键绑定配置）" });
    } else if (typeof bindings !== "object" || Array.isArray(bindings)) {
      checks.push({ id: "keybindings", category: "keybindings", level: "error", message: "按键绑定配置无效：config.json 的 keybindings 不是对象", fix: "改成 {\"<按键>\": \"<命令>\"} 的对象形式，命令不带 /" });
    } else {
      let bad = 0;
      for (const [key, action] of Object.entries(bindings as Record<string, unknown>)) {
        if (!key.trim()) {
          bad += 1;
          checks.push({ id: `keybinding:${key}`, category: "keybindings", level: "error", message: "按键绑定错误：空按键名", fix: "删掉该条绑定" });
          continue;
        }
        if (typeof action !== "string" || !(KNOWN_REPL_COMMANDS as readonly string[]).includes(action.replace(/^\//, "").trim())) {
          bad += 1;
          checks.push({
            id: `keybinding:${key}`, category: "keybindings", level: "error",
            message: `按键绑定错误：${key} → ${typeof action === "string" ? action : JSON.stringify(action)}（未知命令）`,
            fix: `改成已有的 REPL 命令之一：/${KNOWN_REPL_COMMANDS.join("、/")}`,
          });
        }
      }
      if (bad === 0) checks.push({ id: "keybindings", category: "keybindings", level: "ok", message: `按键绑定 ${Object.keys(bindings as Record<string, unknown>).length} 条，目标命令都存在` });
    }
  }

  // 6. 沙箱：显式要求某个后端、实际不可用 = 错误；默认 auto 回落到工具级 = 通过（带说明）。
  {
    const status = getSandboxStatus(config ?? null);
    const explicit = typeof config?.sandbox === "string" ? (config.sandbox as string) : null;
    if (status.level === "none") {
      checks.push({
        id: "sandbox", category: "sandbox", level: "error",
        message: `沙箱不可用：${status.detail}`,
        fix: "装好对应后端（如 bwrap），或把 config.json 的 sandbox 改回 auto/local",
      });
    } else if (explicit && explicit !== "auto" && explicit !== "local" && status.backend === "local") {
      checks.push({
        id: "sandbox", category: "sandbox", level: "error",
        message: `沙箱已回落到工具级隔离：配置要求 ${explicit}，实际 ${status.detail}`,
        fix: "装好对应后端，或把 config.json 的 sandbox 改回 auto/local",
      });
    } else {
      checks.push({ id: "sandbox", category: "sandbox", level: "ok", message: `沙箱：${status.detail}` });
    }
  }

  // 7. 权限设置：解析失败的行、未知工具的规则、被 deny 覆盖的 allow/ask 规则
  // 都是"写了但永远不生效"的设置。工具名先归一化（Bash → shell 等），否则
  // 按文档写的 Claude 风格规则会被误报。
  {
    const section = config?.permissions;
    const rules = parseRules(section as { allow?: unknown; ask?: unknown; deny?: unknown } | null);
    for (const w of rules.warnings) {
      checks.push({ id: `permission:${w}`, category: "permissions", level: "error", message: `被忽略的权限设置：${w}`, fix: "按 Tool(specifier) 的格式重写该规则，见 docs/permissions.md" });
    }
    const known = knownToolNames();
    const all = [
      ...rules.allow.map((r) => ({ action: "allow" as const, rule: r })),
      ...rules.ask.map((r) => ({ action: "ask" as const, rule: r })),
      ...rules.deny.map((r) => ({ action: "deny" as const, rule: r })),
    ];
    for (const { rule } of all) {
      const tool = normalizeToolName(rule.tool);
      if (tool.startsWith("mcp__") || tool === "mcp") continue;
      if (!known.has(tool)) {
        checks.push({
          id: `permission:${rule.raw}`, category: "permissions", level: "error",
          message: `被忽略的权限设置：规则 ${rule.raw} 指向未知工具 ${rule.tool}`,
          fix: "改成已有的工具名，或删掉该规则",
        });
      }
    }
    // deny > ask > allow：与某条 deny 同工具、同 specifier（或 deny 无 specifier）
    // 的 allow/ask 规则永远轮不到，直接报出来。
    for (const { action, rule } of all) {
      if (action === "deny") continue;
      const shadow = rules.deny.find((d) => {
        if (normalizeToolName(d.tool) !== normalizeToolName(rule.tool)) return false;
        return d.specifier === null || d.specifier === rule.specifier;
      });
      if (shadow) {
        checks.push({
          id: `permission-shadow:${rule.raw}`, category: "permissions", level: "warn",
          message: `权限规则永不生效：${action} ${rule.raw} 被 deny 规则 ${shadow.raw} 覆盖（deny 优先）`,
          fix: "删掉这条被覆盖的规则，或收紧 deny 规则的范围",
        });
      }
    }
    // 与 `nyra redlines` 共用同一套死规则判定（lintRules）：否则两个命令会对同一份
    // 配置给出不同结论——"status 说全部可命中、redlines 说有一条永不命中"是自相矛盾。
    // unknown-tool 已由上面更具体的检查覆盖，这里跳过避免重复。
    for (const lint of lintRules(rules, { knownTools: [...known] })) {
      if (lint.code === "unknown-tool") continue;
      checks.push({
        id: `permission-lint:${lint.action}:${lint.raw}`, category: "permissions", level: "warn",
        message: `权限规则可疑（${lint.code}）：${lint.action} ${lint.raw} —— ${lint.detail}`,
        fix: "按 docs/permissions.md 修正 specifier 语法",
      });
    }
    if (rules.warnings.length === 0 && all.length === 0) {
      checks.push({ id: "permissions", category: "permissions", level: "info", message: "未配置权限规则" });
    } else if (!checks.some((c) => c.category === "permissions" && c.level !== "ok" && c.level !== "info")) {
      checks.push({ id: "permissions", category: "permissions", level: "ok", message: `权限规则 ${all.length} 条，全部可解析、可命中` });
    }
  }

  // 8. 钩子：无效条目、不存在/不可执行的脚本、写错的事件名、永不匹配的 matcher。
  {
    const unknownEvents = listUnknownHookEvents(home);
    for (const name of unknownEvents) {
      checks.push({
        id: `hook-event:${name}`, category: "hooks", level: "error",
        message: `未知的钩子事件：${name}`,
        detail: `已知事件：${HOOK_EVENTS.join("、")}`,
        fix: "修正 config.json 里 hooks 一节的事件名拼写",
      });
    }
    const entries = listHookEntries(home);
    const known = knownToolNames();
    const hookEnabled = config?.hooks !== null && typeof config?.hooks === "object" && (config.hooks as Record<string, unknown>).enabled === false;
    let bad = 0;
    for (const ref of entries) {
      if (ref.kind === "invalid") {
        bad += 1;
        checks.push({ id: `hook:${ref.label}`, category: "hooks", level: "error", message: `无效的钩子配置：${ref.label}`, detail: ref.invalidReason ?? "格式错误", fix: "按 docs/hooks.md 的对象写法修正，或删掉该条目" });
        continue;
      }
      if (ref.kind === "command" && ref.path) {
        if (!existsSync(ref.path)) {
          bad += 1;
          checks.push({ id: `hook:${ref.label}`, category: "hooks", level: "error", message: `钩子脚本不存在：${ref.path}`, detail: `事件 ${ref.event}`, fix: "把脚本放回该路径，或删掉这条钩子配置" });
        } else if (process.platform !== "win32") {
          try {
            if ((statSync(ref.path).mode & 0o111) === 0) {
              bad += 1;
              checks.push({ id: `hook:${ref.label}`, category: "hooks", level: "error", message: `钩子脚本不可执行：${ref.path}`, detail: `事件 ${ref.event}`, fix: `chmod +x ${ref.path}` });
            }
          } catch {
            // 读不到 stat 就不报（listHookEntries 已保证文件存在）。
          }
        }
      }
      if (ref.kind === "prompt" || ref.kind === "agent") {
        if (!ref.prompt?.trim()) {
          bad += 1;
          checks.push({ id: `hook:${ref.label}`, category: "hooks", level: "error", message: `钩子缺少 prompt：${ref.label}`, fix: "给该 handler 写上 prompt，或删掉该条目" });
        }
      }
      if (ref.tools) {
        const anyMatch = ref.tools.some((p) => [...known].some((t) => matchHookTool(p, t) || matchHookTool(normalizeToolName(p), t)));
        if (!anyMatch) {
          bad += 1;
          checks.push({
            id: `hook-matcher:${ref.label}`, category: "hooks", level: "error",
            message: `永不匹配的 hook matcher：${ref.label} tools=[${ref.tools.join(", ")}]`,
            detail: `事件 ${ref.event}：没有任何已知工具命中该 matcher，这条钩子永远不会触发`,
            fix: "改成已有的工具名（如 shell、write_file），或删掉 tools 限制",
          });
        }
      }
    }
    if (hookEnabled) {
      checks.push({ id: "hooks", category: "hooks", level: "info", message: "钩子已关闭（hooks.enabled=false），已装的钩子都不会触发" });
    } else if (!entries.length && !unknownEvents.length) {
      checks.push({ id: "hooks", category: "hooks", level: "info", message: "未安装任何钩子" });
    } else if (bad === 0 && !unknownEvents.length) {
      checks.push({ id: "hooks", category: "hooks", level: "ok", message: `钩子 ${entries.length} 条，全部可用` });
    }
  }

  const errors = checks.filter((c) => c.level === "error").length;
  const warnings = checks.filter((c) => c.level === "warn").length;
  return { checks, errors, warnings, ok: errors === 0 };
}

const LEVEL_GLYPH: Record<StatusLevel, string> = { ok: "✓", info: "ℹ", warn: "⚠", error: "✗" };

/** 把诊断结果格式化成终端文本（只读输出，不写盘）。 */
export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = ["状态诊断（只读，未改任何配置）："];
  for (const c of report.checks) {
    lines.push(`${LEVEL_GLYPH[c.level]} [${c.category}] ${c.message}`);
    if (c.detail) lines.push(`    ${c.detail}`);
    if (c.fix) lines.push(`    修法：${c.fix}`);
  }
  const okCount = report.checks.filter((c) => c.level === "ok" || c.level === "info").length;
  lines.push(`共 ${report.checks.length} 项：${okCount} 项通过，${report.warnings} 个警告，${report.errors} 个错误。`);
  if (report.errors > 0) lines.push("有错误配置需要处理（见上）；警告不影响运行。");
  return lines.join("\n");
}
