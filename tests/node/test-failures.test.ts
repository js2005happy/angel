// tests/node/test-failures.test.ts — P1-3：失败三分类（表驱动）。
// 目标：人看前缀、CI 看字段，都能立刻分辨"工具挂 / 模型限流 / 验证没过 / 真出 bug"。
import { test, expect } from "bun:test";
import { classifyFailure, formatFailureLine, classifyRunStatus, FAILURE_CLASSES } from "../../src/failures.ts";
import { ProviderError } from "../../src/providers.ts";
import { ToolError, ApprovalRequired, PatchError } from "../../src/tools.ts";
import { SandboxUnavailableError } from "../../src/sandbox.ts";
import { AgentError } from "../../src/agent.ts";

test("四类都在枚举里（防止后续改动悄悄改名）", () => {
  expect([...FAILURE_CLASSES].sort()).toEqual(["model_error", "runtime_error", "tool_error", "verify_error"]);
});

test("工具层：ToolError / PatchError / ApprovalRequired 都归 tool_error 且不可重试", () => {
  for (const err of [new ToolError("写入失败"), new PatchError("上下文不匹配"), new ApprovalRequired("shell")]) {
    const info = classifyFailure(err);
    expect(info.class).toBe("tool_error");
    expect(info.retryable).toBe(false);
  }
});

test("沙箱不可用 → tool_error（环境问题，不是代码 bug）", () => {
  const info = classifyFailure(new SandboxUnavailableError("bwrap 不可用"));
  expect(info.class).toBe("tool_error");
  expect(info.retryable).toBe(false);
});

test("模型层：限流/超时/5xx 可重试", () => {
  for (const msg of ["HTTP 429 Too Many Requests", "rate limit exceeded", "request timed out", "503 Service Unavailable"]) {
    const info = classifyFailure(new ProviderError(msg));
    expect(info.class).toBe("model_error");
    expect(info.retryable).toBe(true);
  }
});

test("模型层：鉴权失败不可重试（重试也不会变好）", () => {
  const info = classifyFailure(new ProviderError("401 Unauthorized: invalid api key"));
  expect(info.class).toBe("model_error");
  expect(info.retryable).toBe(false);
});

test("成本上限 → runtime_error（既不是工具也不是模型的问题）", () => {
  const info = classifyFailure(new AgentError("成本上限已超：已花费 $2.0000（上限 $1.00），运行已中止"));
  expect(info.class).toBe("runtime_error");
  expect(info.retryable).toBe(false);
});

test("无凭据 → model_error", () => {
  expect(classifyFailure(new AgentError("__NO_CREDENTIALS__")).class).toBe("model_error");
});

test("未知异常 → runtime_error，且不抛", () => {
  for (const err of [new Error("随便什么"), "字符串错误", { weird: true }, null, undefined, 42]) {
    const info = classifyFailure(err);
    expect(info.class).toBe("runtime_error");
    expect(typeof info.message).toBe("string");
    expect(info.retryable).toBe(false);
  }
});

test("网络类兜底：ECONNRESET 判 model_error 且可重试", () => {
  const info = classifyFailure(new Error("read ECONNRESET"));
  expect(info.class).toBe("model_error");
  expect(info.retryable).toBe(true);
});

test("message / errorName 不丢信息", () => {
  const info = classifyFailure(new ToolError("文件不存在：a.txt"));
  expect(info.message).toBe("文件不存在：a.txt");
  expect(info.errorName).toBe("ToolError");
});

test("formatFailureLine：带分类前缀，可重试时额外标注", () => {
  expect(formatFailureLine(classifyFailure(new ToolError("x")))).toStartWith("[tool_error]");
  expect(formatFailureLine(classifyFailure(new ProviderError("HTTP 429")))).toContain("可重试");
  expect(formatFailureLine(classifyFailure(new ToolError("x")))).not.toContain("可重试");
});

test("classifyRunStatus：verify_failed → verify_error；incomplete → runtime_error；其余 null", () => {
  expect(classifyRunStatus("verify_failed")).toBe("verify_error");
  expect(classifyRunStatus("incomplete")).toBe("runtime_error");
  expect(classifyRunStatus("verified")).toBeNull();
  expect(classifyRunStatus("completed_unverified")).toBeNull();
});
