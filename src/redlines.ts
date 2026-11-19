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
import { t } from "./i18n.ts";

export type RedlineLevel = "ok" | "warn" | "fail";

export interface RedlineFinding {
  /** 稳定短码，方便 CI/脚本判定。 */
  code: string;
  level: RedlineLevel;
  title: string;
  detail: string;
  fix?: string;
}

export interface RedlineThresholds {
  /** 工具数量达到多少算"重"。默认 25。 */
  maxTools?: number;
  /** 每轮 schema token 达到多少算"重"。默认 2500。 */
  maxTokensPerTurn?: number;
  /** 占上下文比例达到多少算"重"。默认 0.05（5%）。 */
  maxContextRatio?: number;
}

export const DEFAULT_THRESHOLDS: Required<RedlineThresholds> = {
  maxTools: 25,
  maxTokensPerTurn: 2500,
  maxContextRatio: 0.05,
};
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
  /** 工具集体检结果（由调用方用 toolBudget.measureToolBudget 算好传入）。 */
  toolBudget?: { totalTools: number; tokensPerTurn: number; contextRatio: number | null } | null;
  /** 跨会话回忆状态（开关是否开、总历史数、30 天内的历史数）。 */
  recall?: { enabled: boolean; total: number; fresh: number } | null;
  /**
   * 按项目调的阈值（config.redlines.thresholds）。
   * 不同项目合理值不同：工具本来就多的项目 25 太紧，小项目 5% 太松。
   */
  thresholds?: RedlineThresholds | null;
  /** 明确忽略的检查项 code（config.redlines.ignore）；被忽略的项不会出现在结果里。 */
  ignore?: string[] | null;
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

  // 8) 工具集常驻成本：原生工具每轮都发一遍 schema，工具多就是每轮白烧 token。
  // 注意：延迟加载只覆盖 MCP 工具——MCP > 8 个时自动开启；显式开启
  // features.tool_search / config.tool_search.enabled 时阈值降到 topK
  // （默认 8），即使 MCP 工具不多也会进入延迟加载；NYRA_LAZY_TOOLS=0
  // 一票否决。原生工具集的体积只能靠裁剪控制，tools-bloat 只量原生
  // 工具，不拿 tool_search 当开关。
  const tb = input.toolBudget;
  if (tb) {
    const th = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
    const heavy = tb.totalTools >= th.maxTools || tb.tokensPerTurn >= th.maxTokensPerTurn || (tb.contextRatio !== null && tb.contextRatio >= th.maxContextRatio);
    if (heavy) {
      add({
        code: "tools-bloat",
        level: "warn",
        title: "工具集体积",
        detail: `${tb.totalTools} 个工具、每轮约 ${tb.tokensPerTurn} token${tb.contextRatio !== null ? `（占上下文 ${(tb.contextRatio * 100).toFixed(1)}%）` : ""}；原生工具每轮都会完整发送`,
        fix: "用 --disable-tool / config.disabled_tools 裁掉用不到的工具",
      });
    } else {
      add({ code: "tools-lean", level: "ok", title: "工具集体积", detail: `${tb.totalTools} 个工具、每轮约 ${tb.tokensPerTurn} token，在可接受范围内` });
    }
  }
  // 9) 跨会话回忆：开着但没有新鲜历史 = 看起来在省，其实一点没省
  const rc = input.recall;
  if (rc) {
    if (!rc.enabled) {
      add({
        code: "recall-off",
        level: "warn",
        title: "跨会话回忆",
        detail: "回忆已关闭：同类任务二次运行时会从零重新探索",
        fix: "开 features.run_recall（默认开；被关掉通常是排障遗留）",
      });
    } else if (rc.total === 0) {
      add({
        code: "recall-empty",
        level: "ok",
        title: "跨会话回忆",
        detail: "已开启；还没有历史运行（第一次跑自然不会省）",
      });
    } else if (rc.fresh === 0) {
      add({
        code: "recall-stale",
        level: "warn",
        title: "跨会话回忆",
        detail: `已开启，但 ${rc.total} 条历史全部超过 30 天：现值等价于关闭`,
        fix: "回忆只认 30 天内的运行；要么近期跑一次同类任务积累历史，要么别指望它省 token",
      });
    } else {
      add({
        code: "recall-ready",
        level: "ok",
        title: "跨会话回忆",
        detail: `已开启；${rc.fresh}/${rc.total} 条历史在 30 天内，可复用`,
      });
    }
  }
  // 明确忽略：项目可能"知道这条但暂时不改"，要求是不静默忽略——所以忽略的项不出现，
  // 但被忽略的名字不合法的会在 warnings 里露出（见 validateIgnore）。
  const ignore = new Set((input.ignore ?? []).map((s) => s.trim()).filter(Boolean));
  const kept = ignore.size ? findings.filter((f) => !ignore.has(f.code)) : findings;
    // 全部被忽略时给一条说明，而不是返回空列表——空列表会让人以为"没检查"。
    if (!kept.length) kept.push({ level: "ok", code: "consistent", title: "红线自检", detail: "没有需要报告的检查项（全部通过或被显式忽略）" });
    const fails = kept.filter((f) => f.level === "fail").length;
    const warns = kept.filter((f) => f.level === "warn").length;
  const verdict = fails > 0
    ? `不宜上生产：${fails} 条红线被踩${warns ? `，另有 ${warns} 条提醒` : ""}`
    : warns > 0
      ? `可运行，但 ${warns} 条红线未设：长任务前建议补齐`
      : "红线全绿";

  return { findings: kept, ok: fails === 0, verdict };
}

/** CLI 用：格式化成文本。 */
export function formatRedlines(result: RedlineResult): string {
  const icon = (l: RedlineLevel) => (l === "ok" ? "✅" : l === "warn" ? "⚠️ " : "❌");
  const lines = [t("redlines.title", { verdict: result.verdict }), ""];
  for (const f of result.findings) {
    lines.push(`${icon(f.level)} [${f.code}] ${f.title}：${f.detail}`);
    if (f.fix) lines.push(t("redlines.fix", { fix: f.fix }));
  }
  return lines.join("\n");
}
