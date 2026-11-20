// src/bot/router.ts — Bot 方向 Phase 2：消息路由（角色与工具白名单）。
//
// 角色只认配置里的白名单（config.json 的 `bot` 一节：owner / admins /
// members），不认渠道上报的 senderRole——Telegram 适配器现在所有人都报
// member，且群身份要另外调 getChatMember 才拿得到，拿不到就不能当权限
// 依据。默认外部普通用户是 guest，只读。
//
// 两道门，缺一不可：
//   1. 白名单进模型：Agent 的 disabledTools 按角色的 allowedTools 算，
//      不在白名单的工具根本不出现在发给模型的 schema 里；
//   2. 审批层再拦一次：模型万一幻觉出一个白名单外的工具调用，BotRunner
//      的 approveFn 先查 isToolAllowed 再决定要不要建审批，不在白名单的
//      直接拒绝、不建审批、不发提示（见 index.ts 的 approveViaBridge）。
// 系统提示词走 Agent 的 systemInstructions（buildSystemPrompt 里
// “当前机器人的独立身份与目标”那一段）；每会话一个 Agent 实例，角色变
// 了就重建（BotRunner 按 sessionKey 缓存角色）。
import { MUTATING_TOOLS, READONLY_TOOLS, TOOL_SCHEMAS } from "../tools.ts";
import type { BotPolicy, BotProfileOverride, BotRole, InboundMessage } from "./types.ts";

export type { BotRole } from "./types.ts";

/** 角色画像：系统提示词、工具白名单、步数、超时、能不能发起/批准审批。 */
export interface BotProfile {
  role: BotRole;
  /** 系统提示词（进 Agent 的 systemInstructions；空 = 不加）。 */
  systemPrompt: string;
  /** 模型可见的工具白名单（不在里面的工具不进 schema）。 */
  allowedTools: string[];
  /** 每轮最大步数。 */
  maxTurns: number;
  /** 单条消息超时（毫秒；进会话队列的超时）。 */
  timeoutMs: number;
  /** 模型想做写操作时能不能走 approvalBridge 发起审批。 */
  canRequestApproval: boolean;
  /** 能不能批别人的审批（/approve、/reject、按钮）。 */
  canApprove: boolean;
}

/** Agent 侧的落点（纯函数，BotRunner.buildAgent 原样用，测试直接验）。 */
export interface BotAgentOptions {
  mode: "readonly" | "auto";
  interactive: boolean;
  disabledTools: string[];
  systemInstructions: string;
  maxTurns: number;
}

/** owner 也不给的工具前缀：桌面/浏览器自动化经聊天调用风险太高，Phase 2 不开放。 */
const OWNER_EXCLUDED_PREFIXES = ["browser_", "computer_"];

/** admin 除了只读工具外能用的写工具（仍要逐次审批；shell 不给）。 */
const ADMIN_WRITE_TOOLS = ["write_file", "edit_file", "plan", "memory_append"];

/** guest 的步数与超时收得更紧（外部陌生人默认只读、少烧钱）。 */
const GUEST_MAX_TURNS = 6;
const GUEST_TIMEOUT_MS = 60000;

/** TOOL_SCHEMAS 里的全部工具名（白名单的宇宙；动态加的 search_tools 等不在内）。 */
export function allToolNames(): string[] {
  const names: string[] = [];
  for (const s of TOOL_SCHEMAS) {
    const fn = (s as Record<string, unknown>).function as Record<string, unknown> | undefined;
    if (typeof fn?.name === "string" && fn.name) names.push(fn.name);
  }
  return names;
}

/** 某角色的工具白名单（代码定死，配置只能改步数/超时/提示词，不能改白名单——白名单是安全边界）。 */
export function toolsForRole(role: BotRole): string[] {
  const readonly = [...READONLY_TOOLS];
  switch (role) {
    case "owner":
      return allToolNames().filter((n) => !OWNER_EXCLUDED_PREFIXES.some((p) => n.startsWith(p)));
    case "admin":
      return [...new Set([...readonly, ...ADMIN_WRITE_TOOLS])];
    case "member":
    case "guest":
      return readonly;
  }
}

/** 按 senderId 认角色：owner > admins > members > 默认 guest。 */
export function resolveRole(msg: Pick<InboundMessage, "senderId">, policy: BotPolicy): BotRole {
  if (policy.owner !== null && msg.senderId === policy.owner) return "owner";
  if (policy.admins.includes(msg.senderId)) return "admin";
  if (policy.members.includes(msg.senderId)) return "member";
  return "guest";
}

/** 角色画像：步数/超时/提示词可被配置覆盖；能不能发起/批准审批是硬边界、配置改不了。 */
export function profileForRole(role: BotRole, policy: BotPolicy, chatId?: string | null): BotProfile {
  const over: BotProfileOverride = policy.profiles?.[role] ?? {};
  const baseMaxTurns = role === "guest" ? Math.min(policy.maxTurns, GUEST_MAX_TURNS) : policy.maxTurns;
  const baseTimeoutMs = role === "guest" ? Math.min(policy.timeoutMs, GUEST_TIMEOUT_MS) : policy.timeoutMs;
  let systemPrompt = over.systemPrompt ?? "";
  // 按 chatId 的提示词覆盖优先于按角色的（特定群聊可以有自己的 Bot 人设）。
  if (chatId && policy.chatSystemPrompts[chatId]) systemPrompt = policy.chatSystemPrompts[chatId];
  return {
    role,
    systemPrompt,
    allowedTools: toolsForRole(role),
    maxTurns: over.maxTurns ?? baseMaxTurns,
    timeoutMs: over.timeoutMs ?? baseTimeoutMs,
    canRequestApproval: role === "owner" || role === "admin",
    canApprove: role === "owner" || role === "admin",
  };
}

/** 工具在不在该角色的白名单里（审批层第二道门用）。 */
export function isToolAllowed(profile: BotProfile, tool: string): boolean {
  return profile.allowedTools.includes(tool);
}

/** 画像 → Agent 构造参数。写工具一个没有时 mode 只能是 readonly（interactive 也不开，approveFn 够不着）；有写工具且能发起审批时才开 auto + interactive + approveFn。 */
export function agentOptionsForProfile(profile: BotProfile): BotAgentOptions {
  const canWrite = profile.allowedTools.some((t) => MUTATING_TOOLS.has(t));
  const writable = canWrite && profile.canRequestApproval;
  return {
    mode: writable ? "auto" : "readonly",
    interactive: writable,
    disabledTools: allToolNames().filter((n) => !profile.allowedTools.includes(n)),
    systemInstructions: profile.systemPrompt,
    maxTurns: profile.maxTurns,
  };
}
