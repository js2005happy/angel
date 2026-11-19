// src/failures.ts — P1-3：失败三分类。
//
// 现状问题：所有失败最后都变成一句"出错了"，人和 CI 都没法据此决策——工具挂了要重试、
// 模型限流要等、验证没过要改代码，这是三件完全不同的事。
//
// 这里只做一件事：把任意异常分类成四类之一，并给出是否值得重试。分类是纯函数，
// 便于单测；真正的输出接线在 cli.ts。
//
//   tool_error    工具层失败：命令非零退出、补丁冲突、审批拒绝、沙箱不可用
//   model_error   模型/provider 层失败：限流、鉴权、超时、返回体异常
//   verify_error  验证层失败：验证命令未通过（由 runs 状态推导，不是异常）
//   runtime_error 其他：配置错、状态文件损坏、成本超限、参数非法
//
// 约定：**分类不改变退出码**（退出码仍由既有 EXIT_* 决定），只增加可判定性。
import { AgentError } from "./agent.ts";
import { ProviderError } from "./providers.ts";
import { ToolError, ApprovalRequired, PatchError } from "./tools.ts";
import { SandboxUnavailableError } from "./sandbox.ts";
import { SeatbeltUnavailableError } from "./seatbelt.ts";
import { RunNotResumable } from "./runs.ts";

export type FailureClass = "tool_error" | "model_error" | "verify_error" | "runtime_error";

export const FAILURE_CLASSES: readonly FailureClass[] = [
  "tool_error", "model_error", "verify_error", "runtime_error",
];

export interface FailureInfo {
  class: FailureClass;
  message: string;
  /** 是否值得让调用方重试（限流/超时可重试；补丁冲突、鉴权失败不可）。 */
  retryable: boolean;
  /** 供日志用的原始错误名（不暴露堆栈）。 */
  errorName: string;
}

const RETRYABLE_MODEL_HINTS = [/429/, /rate.?limit/i, /timeout/i, /timed out/i, /\b5\d\d\b/, /overloaded/i, /ECONNRESET/i, /503/, /502/];

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function nameOf(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor?.name || "Error";
  return typeof err;
}

/**
 * 把一个异常归类。判定顺序很重要：先看最常见的具体类型，最后兜底 runtime。
 * 不抛异常——分类器自己出问题会让错误处理链崩掉，这比分类不准更糟。
 */
export function classifyFailure(err: unknown): FailureInfo {
  const message = messageOf(err);
  const errorName = nameOf(err);

  const base = (cls: FailureClass, retryable: boolean): FailureInfo => ({ class: cls, message, retryable, errorName });

  // 模型/provider 层
  if (err instanceof ProviderError) {
    const retryable = RETRYABLE_MODEL_HINTS.some((re) => re.test(message));
    return base("model_error", retryable);
  }

  // 工具层
  if (err instanceof ApprovalRequired) return base("tool_error", false);
  if (err instanceof ToolError || err instanceof PatchError) return base("tool_error", false);
  if (err instanceof SandboxUnavailableError || err instanceof SeatbeltUnavailableError) {
    // 沙箱起不来是环境问题，重试无意义，但要能被识别成"工具跑不了"而不是"代码有 bug"
    return base("tool_error", false);
  }

  // 验证层（异常形式出现的极少：主要是状态推导，见 runs.ts）
  if (/verify/i.test(errorName) || /验证命令未通过/.test(message)) return base("verify_error", false);

  // AgentError：成本上限 / 无凭据 / 其他
  if (err instanceof AgentError) {
    if (/^成本上限已超/.test(message)) return base("runtime_error", false);
    if (message === "__NO_CREDENTIALS__" || /凭据|API key/i.test(message)) return base("model_error", false);
    return base("runtime_error", false);
  }

  if (err instanceof RunNotResumable) return base("runtime_error", false);

  // 兜底：网络类错误按模型层重试，其余 runtime
  if (RETRYABLE_MODEL_HINTS.some((re) => re.test(message))) return base("model_error", true);
  return base("runtime_error", false);
}

/** 非 JSON 输出时的单行前缀，例如 `[model_error] 429 ...`。 */
export function formatFailureLine(info: FailureInfo): string {
  return `[${info.class}]${info.retryable ? "（可重试）" : ""} ${info.message}`;
}

/** 从运行状态推导失败分类：verify_failed → verify_error；incomplete → runtime_error。 */
export function classifyRunStatus(status: string): FailureClass | null {
  if (status === "verify_failed") return "verify_error";
  if (status === "incomplete") return "runtime_error";
  return null;
}
