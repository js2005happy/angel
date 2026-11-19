// src/redlines.ts — 「上线红线」自检（docs/VISION-NEXT.md 第七节的可执行化）。
//
// 为什么单独一层：`doctor` 查的是"能不能跑起来"（运行时、Key、网络、磁盘），
// 这一层查的是"敢不敢把它放进生产"——两者失败时的心智完全不同：
// 跑不起来会立刻发现；红线没设好则会在某次长任务里悄悄出事（超预算、裸奔、无验证）。
//
// 设计纪律：
//   - 纯函数，输入就是 config + 探测结果，不读文件、不 spawn（探测由调用方注入）
//   - 每条红线都给出"为什么"与"怎么修"，不写空洞的 pass/fail
//   - 缺省配置在本地开发是合理的，所以大部分红线是 **warn** 而不是 fail；
//     只有"明确危险"的才 fail（例如 permissions 把 deny 全放开、沙箱与审批同时关闭）
import type { PermissionRule } from "./permissionRules.ts";

export type RedlineLevel = "ok" | "warn" | "fail";

export interface RedlineFinding {
  /** 稳定短码，方便 CI/脚本判定。 */
  code: string;
  level: RedlineLevel;
  title: string;
  detail: string;
  fix?: string;
}

export interface RedlineInput {
  config: Record<string, unknown>;
  /** 沙箱探测结果（由调用方用 sandbox.ts 解析后传入；null = 未探测）。 */
  sandbox?: { level: string; backend: string } | null;
  /** 解析后的权限规则（由调用方用 permissionRules.parseRules 解析）。 */
  permissions?: { allow: PermissionRule[]; ask: PermissionRule[]; deny: PermissionRule[] } | null;
  /** 是否配置了单次成本上限。 */
  hasCostLimit?: boolean;
  /** 是否配置了日志/pricing 之类可选项（默认不参与判定）。 */
  platform?: string;
}

export interface RedlineResult {
  findings: RedlineFinding[];
  /** 没有 fail 即视为"可以上生产"（warn 需要人工确认）。 */
  ok: boolean;
  /** 一句话结论。 */
  verdict: string;
}

function isOn(v: unknown): boolean {
  return v === true || v === "1" || v === 1 || v === "true" || v === "yes";
}

/**
 * 跑一遍红线。顺序固定（ok → warn → fail 的展示顺序由调用方决定，这里按检查项顺序）。
 */
export function checkRedlines(input: RedlineInput): RedlineResult {
  const { config } = input;
  const findings: RedlineFinding[] = [];
  const add = (f: RedlineFinding) => findings.push(f);

  // 1) 成本上限：长任务最容易失控的地方
  if (input.hasCostLimit) {
    add({ code: "cost-limit-set", level: "ok", title: "成本上限", detail: "已配置单次运行上限，超支会中止（不是只警告）" });
  } else {
    add({
      code: "cost-limit-missing",
      level: "warn",
      title: "成本上限",
      detail: "未配置 max_cost_usd，长时间运行可能无限烧钱",
      fix: 'config.json 里加 "max_cost_usd": 5（或用 --max-cost）',
    });
  }

  // 2) 定价：没有单价，金额一律"未知"，上限也就无从判定
  const pricing = config.pricing;
  const hasPricing = pricing && typeof pricing === "object" && Object.keys(pricing as object).length > 0;
  if (hasPricing) {
    add({ code: "pricing-set", level: "ok", title: "模型定价", detail: "已配置定价，成本可计算" });
  } else {
    add({
      code: "pricing-missing",
      level: "warn",
      title: "模型定价",
      detail: "未配置 pricing，成本显示为「未知」，--max-cost 无法生效（不知道单价就没法判超支）",
      fix: 'config.json 加 "pricing": {"<model>": {"input_per_1m": 0.28, "output_per_1m": 0.42}}',
    });
  }

  // 3) OS 沙箱：shell 是否真的被关进笼子
  const lvl = input.sandbox?.level ?? "none";
  if (lvl === "bwrap" || lvl === "seatbelt") {
    add({ code: "sandbox-os-level", level: "ok", title: "OS 沙箱", detail: `shell 走 ${lvl}（内核级拦截），后端 ${input.sandbox?.backend}` });
  } else if (lvl === "tool-level") {
    add({
      code: "sandbox-tool-level",
      level: "warn",
      title: "OS 沙箱",
      detail: "当前是工具级隔离，命令在宿主机上跑，只有黑名单与审批，没有内核级拦截",
      fix: "Linux 装 bwrap（--sandbox bwrap）；macOS 用 --sandbox seatbelt",
    });
  } else {
    add({
      code: "sandbox-none",
      level: "warn",
      title: "OS 沙箱",
      detail: "未探测到沙箱能力，shell 完全裸跑",
      fix: "先跑 nyra doctor 看隔离级别；确认后按平台装 bwrap 或用 --sandbox seatbelt",
    });
  }

  // 4) 沙箱与"无限制模式"互斥：danger-full-access 不该和沙箱同时被信任
  const mode = typeof config.sandbox_mode === "string" ? config.sandbox_mode : "";
  if (mode === "danger-full-access") {
    add({
      code: "sandbox-danger-mode",
      level: "fail",
      title: "沙箱模式",
      detail: "sandbox_mode 是 danger-full-access：明确放弃了内核级隔离，任何命令都可执行",
      fix: '改回 "workspace-write"；确实需要无限制请单次用 --sandbox local 并自行承担',
    });
  }

  // 5) 权限规则：deny 为空 = 没有一条硬拒绝，全靠交互审批
  const perms = input.permissions;
  if (perms) {
    if (perms.deny.length > 0) {
      add({ code: "deny-rules-present", level: "ok", title: "权限硬拒绝", detail: `已配置 ${perms.deny.length} 条 deny 规则` });
    } else {
      add({
        code: "deny-rules-empty",
        level: "warn",
        title: "权限硬拒绝",
        detail: "没有任何 deny 规则：危险命令只能靠人工在弹窗里拒",
        fix: 'config.json 加 "permissions": {"deny": ["Bash(rm -rf *)", "Bash(git push --force *)"]}',
      });
    }
    // 放开了 Bash 全量 = 等于没有 shell 约束
    const allowsAllBash = perms.allow.some((r) => r.tool === "Bash" && r.specifier === null);
    if (allowsAllBash) {
      add({
        code: "allow-all-shell",
        level: "fail",
        title: "权限规则",
        detail: "allow 里有裸 Bash——所有命令免审批直通，等同于关掉审批",
        fix: '把 "Bash" 改成具体命令（如 "Bash(git *)"），或至少配一条对应的 deny',
      });
    }
  }

  // 6) 验证命令：没有它，"完成"就无法自证
  const verifyCmd = typeof config.verify_command === "string" ? config.verify_command.trim() : "";
  if (verifyCmd) {
    add({ code: "verify-configured", level: "ok", title: "验证命令", detail: `已配置：${verifyCmd}` });
  } else {
    add({
      code: "verify-missing",
      level: "warn",
      title: "验证命令",
      detail: "未配置 verify_command，运行结束后只能得到 completed_unverified（未验证），不能算完成",
      fix: 'config.json 加 "verify_command": "npm test"（或运行时用 --verify）',
    });
  }

  // 7) 钩子全局关闭：审计留痕没了
  const hooksSection = config.hooks;
  const hooksExplicitlyOff = hooksSection && typeof hooksSection === "object" && (hooksSection as Record<string, unknown>).enabled === false;
  if (hooksExplicitlyOff || isOn(process.env?.NYRA_HOOKS === "0")) {
    add({
      code: "hooks-disabled",
      level: "warn",
      title: "钩子",
      detail: "钩子层被关闭：PreToolUse 的参数改写与拦截都不会发生，审计留痕减少",
      fix: 'config.json 的 hooks.enabled 改回 true；NYRA_HOOKS=0 只用于临时排障',
    });
  }

  const fails = findings.filter((f) => f.level === "fail").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  const verdict = fails > 0
    ? `不宜上生产：${fails} 条红线被踩${warns ? `，另有 ${warns} 条提醒` : ""}`
    : warns > 0
      ? `可运行，但 ${warns} 条红线未设：长任务前建议补齐`
      : "红线全绿";

  return { findings, ok: fails === 0, verdict };
}

/** CLI 用：格式化成文本。 */
export function formatRedlines(result: RedlineResult): string {
  const icon = (l: RedlineLevel) => (l === "ok" ? "✅" : l === "warn" ? "⚠️ " : "❌");
  const lines = [`上线红线自检：${result.verdict}`, ""];
  for (const f of result.findings) {
    lines.push(`${icon(f.level)} [${f.code}] ${f.title}：${f.detail}`);
    if (f.fix) lines.push(`    修复：${f.fix}`);
  }
  return lines.join("\n");
}
