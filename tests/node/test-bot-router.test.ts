// tests/node/test-bot-router.test.ts — Bot 方向 Phase 2：角色路由与工具白名单。
// 纯函数测试，不联网、不调模型。
import { test, expect } from "bun:test";
import { agentOptionsForProfile, allToolNames, isToolAllowed, profileForRole, resolveRole, toolsForRole } from "../../src/bot/router.ts";
import { botPolicyFromConfig, DEFAULT_BOT_POLICY } from "../../src/bot/types.ts";
import { READONLY_TOOLS } from "../../src/tools.ts";

function policy(over: Record<string, unknown> = {}) {
  return botPolicyFromConfig({ bot: over });
}

test("角色：只认配置白名单，owner > admins > members > 默认 guest", () => {
  const p = policy({ owner: "1", admins: ["2"], members: ["3"] });
  expect(resolveRole({ senderId: "1" }, p)).toBe("owner");
  expect(resolveRole({ senderId: "2" }, p)).toBe("admin");
  expect(resolveRole({ senderId: "3" }, p)).toBe("member");
  expect(resolveRole({ senderId: "99" }, p)).toBe("guest");
  // 没配 owner/admins/members 时所有人都是 guest。
  expect(resolveRole({ senderId: "1" }, policy({}))).toBe("guest");
});

test("白名单：guest/member 只有只读工具，admin 没有 shell，owner 有 shell 但没有浏览器/桌面工具", () => {
  const guest = toolsForRole("guest");
  expect([...guest].sort()).toEqual([...READONLY_TOOLS].sort());
  expect(toolsForRole("member")).toEqual(guest);
  const admin = toolsForRole("admin");
  for (const t of ["write_file", "edit_file", "plan", "memory_append"]) expect(admin).toContain(t);
  for (const t of ["shell", "http_post", "gmail_send", "save_skill", "memory_delete", "apply_patch"]) expect(admin).not.toContain(t);
  const owner = toolsForRole("owner");
  expect(owner).toContain("shell");
  expect(owner).toContain("write_file");
  for (const t of owner) {
    expect(t.startsWith("browser_")).toBe(false);
    expect(t.startsWith("computer_")).toBe(false);
  }
  expect(allToolNames().length).toBeGreaterThan(READONLY_TOOLS.size);
});

test("画像：guest 步数/超时收紧，owner/admin 能发起与批准审批，guest/member 不能", () => {
  const p = policy({});
  const guest = profileForRole("guest", p);
  expect(guest.maxTurns).toBeLessThanOrEqual(6);
  expect(guest.timeoutMs).toBeLessThanOrEqual(60000);
  expect(guest.canRequestApproval).toBe(false);
  expect(guest.canApprove).toBe(false);
  const member = profileForRole("member", p);
  expect(member.maxTurns).toBe(p.maxTurns);
  expect(member.canRequestApproval).toBe(false);
  expect(member.canApprove).toBe(false);
  const admin = profileForRole("admin", p);
  expect(admin.canRequestApproval).toBe(true);
  expect(admin.canApprove).toBe(true);
  const owner = profileForRole("owner", p);
  expect(owner.canRequestApproval).toBe(true);
  expect(owner.canApprove).toBe(true);
});

test("画像覆盖：按角色的提示词可配，按 chatId 的覆盖优先于按角色的", () => {
  const p = policy({
    profiles: { admin: { system_prompt: "你是客服", max_turns: 3 } },
    chat_system_prompts: { "-100": "你是群客服" },
  });
  expect(profileForRole("admin", p, "-100").systemPrompt).toBe("你是群客服");
  expect(profileForRole("admin", p, "-200").systemPrompt).toBe("你是客服");
  expect(profileForRole("admin", p, "-200").maxTurns).toBe(3);
  expect(profileForRole("guest", p).systemPrompt).toBe("");
});

test("isToolAllowed：白名单外的直接判否", () => {
  const admin = profileForRole("admin", policy({}));
  expect(isToolAllowed(admin, "write_file")).toBe(true);
  expect(isToolAllowed(admin, "shell")).toBe(false);
  const guest = profileForRole("guest", policy({}));
  expect(isToolAllowed(guest, "read_file")).toBe(true);
  expect(isToolAllowed(guest, "write_file")).toBe(false);
});

test("Agent 落点：guest 只读不交互，owner 自动+交互+白名单外全禁", () => {
  const guest = agentOptionsForProfile(profileForRole("guest", policy({})));
  expect(guest.mode).toBe("readonly");
  expect(guest.interactive).toBe(false);
  expect(guest.disabledTools).toContain("shell");
  expect(guest.disabledTools).toContain("write_file");
  expect(guest.disabledTools).not.toContain("read_file");
  const owner = agentOptionsForProfile(profileForRole("owner", policy({})));
  expect(owner.mode).toBe("auto");
  expect(owner.interactive).toBe(true);
  expect(owner.disabledTools).not.toContain("shell");
  expect(owner.disabledTools).not.toContain("write_file");
  expect(owner.disabledTools).toContain("browser_navigate");
  const admin = agentOptionsForProfile(profileForRole("admin", policy({})));
  expect(admin.mode).toBe("auto");
  expect(admin.disabledTools).toContain("shell");
  expect(admin.disabledTools).not.toContain("write_file");
  expect(admin.systemInstructions).toBe("");
  const withPrompt = agentOptionsForProfile(profileForRole("admin", policy({ profiles: { admin: { system_prompt: "客服" } } })));
  expect(withPrompt.systemInstructions).toBe("客服");
});

test("策略解析：owner/members/审批 TTL/审批会话/画像覆盖，非法值回默认", () => {
  const p = policy({
    owner: " 1 ",
    members: ["3", 4, ""],
    approval_timeout_ms: 30000,
    approval_chat_id: " 5 ",
    profiles: { guest: { max_turns: 0, timeout_ms: -1, system_prompt: "  " } },
  });
  expect(p.owner).toBe("1");
  expect(p.members).toEqual(["3"]);
  expect(p.approvalTimeoutMs).toBe(30000);
  expect(p.approvalChatId).toBe("5");
  // 非法覆盖（步数 0、超时负数、空提示词）一律丢弃。
  expect(p.profiles.guest).toBeUndefined();
  // TTL 夹在 5 秒到 10 分钟之间。
  expect(policy({ approval_timeout_ms: 1 }).approvalTimeoutMs).toBe(5000);
  expect(policy({ approval_timeout_ms: 99999999 }).approvalTimeoutMs).toBe(600000);
  expect(policy({ approval_timeout_ms: "x" }).approvalTimeoutMs).toBe(DEFAULT_BOT_POLICY.approvalTimeoutMs);
  expect(policy({}).owner).toBeNull();
  expect(policy({}).members).toEqual([]);
  expect(policy({}).approvalChatId).toBeNull();
});
