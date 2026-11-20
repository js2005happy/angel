// tests/node/test-responsibilities.test.ts — 常驻责任巡查（缺口 8）真测：
// 校验/存储/到期/结论解析按函数测；runPatrol 用假 provider 真跑任务队列，
// 断言无人值守写操作被拦、事件进证据链、汇报条件控制收件箱；网关清单
// 只给元数据。全部 mock-only，不连真实服务、不调模型。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResponsibilityError, addResponsibility, buildPatrolPrompt, dueResponsibilities,
  isResponsibilityDue, listResponsibilitiesPublic, loadResponsibilities, parsePatrolConclusion,
  removeResponsibility, responsibilitiesPath, runDueResponsibilities, runPatrol,
  saveResponsibilities, setResponsibilityEnabled, validateResponsibility,
} from "../../src/responsibilities.ts";
import { addTask, listTasks, loadInbox, showTask } from "../../src/tasks.ts";
import { RunStore } from "../../src/runs.ts";
import { Provider } from "../../src/providers.ts";
import { echoProvider, fakeProvider } from "./fake-provider.ts";
import { Gateway } from "../../src/gateway.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-resp-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-resp-wd-"));
  return { home, workdir };
}

function makeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "依赖安全更新", goal: "检查依赖有没有可用的安全更新，有就记下来",
    every_seconds: 600, report: "on-finding", ...overrides,
  };
}

function storeFor(home: string): RunStore {
  return new RunStore(join(home, "tasks"));
}

function textReply(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}

test("ResponsibilitiesTest.test_validate_rejects_mode_key", () => {
    expect(() => validateResponsibility(makeRaw({ mode: "auto" }))).toThrow(ResponsibilityError);
    expect(() => validateResponsibility(makeRaw({ mode: "readonly" }))).toThrow(ResponsibilityError);
    // mode 为 undefined/null 不算“给了模式”，照常通过（巡查永远只读，无档位可写）。
    expect(validateResponsibility(makeRaw({ mode: undefined })).name).toBe("依赖安全更新");
    expect(validateResponsibility(makeRaw({ mode: null })).name).toBe("依赖安全更新");
  });

test("ResponsibilitiesTest.test_validate_bounds", () => {
    expect(() => validateResponsibility(makeRaw({ name: "" }))).toThrow(ResponsibilityError);
    expect(() => validateResponsibility(makeRaw({ name: "x".repeat(101) }))).toThrow(ResponsibilityError);
    expect(() => validateResponsibility(makeRaw({ goal: "" }))).toThrow(ResponsibilityError);
    expect(() => validateResponsibility(makeRaw({ goal: "x".repeat(8001) }))).toThrow(ResponsibilityError);
    expect(() => validateResponsibility(makeRaw({ every_seconds: 59 }))).toThrow(ResponsibilityError);
    expect(() => validateResponsibility(makeRaw({ every_seconds: 60.5 }))).toThrow(ResponsibilityError);
    expect(() => validateResponsibility(makeRaw({ report: "daily" }))).toThrow(ResponsibilityError);
    expect(() => validateResponsibility(makeRaw({ max_turns: 0 }))).toThrow(ResponsibilityError);
    expect(validateResponsibility(makeRaw({ every_seconds: 60 })).every_seconds).toBe(60);
  });

test("ResponsibilitiesTest.test_validate_defaults", () => {
    const r = validateResponsibility(makeRaw());
    expect(r.report).toBe("on-finding");
    expect(r.enabled).toBe(true);
    expect(r.max_turns).toBe(20);
    expect(r.workdir).toBeNull();
    expect(/^[0-9a-f]{16}$/.test(r.id)).toBe(true);
    expect(validateResponsibility(makeRaw({ enabled: false })).enabled).toBe(false);
    expect(validateResponsibility(makeRaw({ report: "always" })).report).toBe("always");
  });

test("ResponsibilitiesTest.test_add_remove_enable", () => {
    const data = { responsibilities: [] };
    const added = addResponsibility(data, makeRaw());
    expect(data.responsibilities.length).toBe(1);
    expect(() => addResponsibility(data, makeRaw())).toThrow(ResponsibilityError);
    expect(setResponsibilityEnabled(data, added.name, false)).toBe(true);
    expect(data.responsibilities[0].enabled).toBe(false);
    expect(setResponsibilityEnabled(data, "没有这个责任", true)).toBe(false);
    expect(removeResponsibility(data, "没有这个责任")).toBe(false);
    expect(removeResponsibility(data, added.name)).toBe(true);
    expect(data.responsibilities.length).toBe(0);
  });

test("ResponsibilitiesTest.test_save_load_roundtrip", () => {
    const { home } = setup();
    const data = { responsibilities: [validateResponsibility(makeRaw()), validateResponsibility(makeRaw({ name: "磁盘空间", goal: "检查磁盘剩余空间", every_seconds: 3600, report: "always" }))] };
    const p = saveResponsibilities(data, responsibilitiesPath(home));
    expect(existsSync(p)).toBe(true);
    const loaded = loadResponsibilities(p);
    expect(loaded.responsibilities.map((r) => r.name)).toEqual(["依赖安全更新", "磁盘空间"]);
    expect(loaded.responsibilities[1].report).toBe("always");
    // 空 home 读不到文件时返回空清单，不抛错。
    const empty = loadResponsibilities(responsibilitiesPath(mkdtempSync(join(tmpdir(), "nyra-resp-empty-"))));
    expect(empty.responsibilities).toEqual([]);
  });

test("ResponsibilitiesTest.test_load_corrupt_file_backs_up_and_throws", () => {
    const { home } = setup();
    const p = responsibilitiesPath(home);
    writeFileSync(p, "{ not json", "utf-8");
    expect(() => loadResponsibilities(p)).toThrow(ResponsibilityError);
    const backups = readdirSync(home).filter((f) => f.startsWith("responsibilities.json.corrupt-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(home, backups[0]), "utf-8")).toBe("{ not json");
  });

test("ResponsibilitiesTest.test_load_skips_invalid_items", () => {
    const { home } = setup();
    const p = responsibilitiesPath(home);
    writeFileSync(p, JSON.stringify({ responsibilities: [makeRaw(), makeRaw({ name: "", goal: "x" }), makeRaw({ name: "磁盘空间", goal: "看磁盘", every_seconds: 3600 })] }), "utf-8");
    const loaded = loadResponsibilities(p);
    expect(loaded.responsibilities.map((r) => r.name)).toEqual(["依赖安全更新", "磁盘空间"]);
  });

test("ResponsibilitiesTest.test_due_logic", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    const fresh = validateResponsibility(makeRaw({ last_check: "2026-11-20T09:55:00Z" }));
    expect(isResponsibilityDue(fresh, now)).toBe(false);
    const stale = validateResponsibility(makeRaw({ last_check: "2026-11-20T09:49:00Z" }));
    expect(isResponsibilityDue(stale, now)).toBe(true);
    const never = validateResponsibility(makeRaw());
    expect(isResponsibilityDue(never, now)).toBe(true);
    const disabled = validateResponsibility(makeRaw({ enabled: false }));
    expect(isResponsibilityDue(disabled, now)).toBe(false);
    const badDate = validateResponsibility(makeRaw({ last_check: "not-a-date" }));
    expect(isResponsibilityDue(badDate, now)).toBe(true);
    const data = { responsibilities: [fresh, stale, never, disabled] };
    expect(dueResponsibilities(data, now).map((r) => r.name)).toEqual(["依赖安全更新", "依赖安全更新"]);
  });

test("ResponsibilitiesTest.test_build_patrol_prompt", () => {
    const prompt = buildPatrolPrompt(validateResponsibility(makeRaw()));
    expect(prompt).toContain("检查依赖有没有可用的安全更新");
    expect(prompt).toContain("只读巡查");
    expect(prompt).toContain("巡查结论：有发现");
    expect(prompt).toContain("巡查结论：无发现");
    // 提示词里不出现写工具名：只读是写进提示词的，不是口头约定。
    expect(prompt).not.toContain("write_file");
    expect(prompt).not.toContain("edit_file");
  });

test("ResponsibilitiesTest.test_parse_patrol_conclusion", () => {
    expect(parsePatrolConclusion("一切正常。\n巡查结论：无发现")).toBe(false);
    expect(parsePatrolConclusion("巡查结论：有发现\n- 依赖 A 有安全更新")).toBe(true);
    // 以最后一个结论行为准。
    expect(parsePatrolConclusion("巡查结论：无发现\n巡查结论：有发现")).toBe(true);
    expect(parsePatrolConclusion("巡查结论：有发现\n巡查结论：无发现")).toBe(false);
    // 没有结论行时按“有发现”处理（fail-closed：宁可多汇报，不漏报）。
    expect(parsePatrolConclusion("一切正常，没写结论行。")).toBe(true);
    expect(parsePatrolConclusion("")).toBe(true);
  });

test("ResponsibilitiesTest.test_add_task_unattended_forces_readonly", () => {
    const { home, workdir } = setup();
    const store = storeFor(home);
    const st = addTask("做点事", { workdir, mode: "auto", unattended: true, store, home });
    expect(st.mode).toBe("readonly");
    expect(st.unattended).toBe(true);
    // 调用方误传 full 也按只读落盘（无人值守没有可写档位）。
    const st2 = addTask("做点事", { workdir, mode: "full", unattended: true, store, home });
    expect(st2.mode).toBe("readonly");
    const normal = addTask("做点事", { workdir, mode: "auto", store, home });
    expect(normal.mode).toBe("auto");
    expect(normal.unattended).toBe(false);
    expect(listTasks(store).length).toBe(3);
  });

test("ResponsibilitiesTest.test_run_patrol_no_finding_quiet", async () => {
    const { home, workdir } = setup();
    const resp = validateResponsibility(makeRaw());
    const result = await runPatrol(resp, {
        home, workdir, provider: echoProvider("检查完毕，没有可用的安全更新。\n巡查结论：无发现") as unknown as Provider,
      });
    expect(result.status).toMatch(/^completed/);
    expect(result.hasFindings).toBe(false);
    expect(result.reported).toBe(false);
    expect(result.runId).not.toBeNull();
    expect(resp.last_status).toBe("completed_unverified");
    expect(resp.last_summary).toContain("无发现");
    // on-finding + 无发现：不写收件箱，不打扰人。
    expect(loadInbox(home)).toEqual([]);
    const [shown, events] = showTask(result.runId!, storeFor(home));
    expect(shown.unattended).toBe(true);
    expect(shown.mode).toBe("readonly");
    const report = events.find((e) => e.type === "patrol_report") as Record<string, unknown> | undefined;
    expect(report).toBeDefined();
    expect(report!.findings).toBe(false);
    expect(report!.reported).toBe(false);
    expect(report!.responsibility_name).toBe("依赖安全更新");
  });

test("ResponsibilitiesTest.test_run_patrol_finding_reports", async () => {
    const { home, workdir } = setup();
    const resp = validateResponsibility(makeRaw());
    const result = await runPatrol(resp, {
        home, workdir, provider: echoProvider("- 依赖 lodash 有高危更新。\n巡查结论：有发现") as unknown as Provider,
      });
    expect(result.hasFindings).toBe(true);
    expect(result.reported).toBe(true);
    const inbox = loadInbox(home);
    expect(inbox.length).toBe(1);
    expect(String(inbox[0].summary ?? inbox[0].text ?? "")).toContain("依赖安全更新");
    const [, events] = showTask(result.runId!, storeFor(home));
    const report = events.find((e) => e.type === "patrol_report") as Record<string, unknown> | undefined;
    expect(report!.findings).toBe(true);
    expect(report!.reported).toBe(true);
  });

test("ResponsibilitiesTest.test_run_patrol_always_reports_even_without_finding", async () => {
    const { home, workdir } = setup();
    const resp = validateResponsibility(makeRaw({ report: "always" }));
    const result = await runPatrol(resp, {
        home, workdir, provider: echoProvider("巡查结论：无发现") as unknown as Provider,
      });
    expect(result.hasFindings).toBe(false);
    expect(result.reported).toBe(true);
    expect(loadInbox(home).length).toBe(1);
  });

test("ResponsibilitiesTest.test_run_patrol_missing_conclusion_reports_as_finding", async () => {
    const { home, workdir } = setup();
    const resp = validateResponsibility(makeRaw());
    const result = await runPatrol(resp, {
        home, workdir, provider: echoProvider("检查完毕，没有可用的安全更新。") as unknown as Provider,
      });
    expect(result.hasFindings).toBe(true);
    expect(result.reported).toBe(true);
    expect(loadInbox(home).length).toBe(1);
  });

test("ResponsibilitiesTest.test_run_patrol_write_blocked", async () => {
    const { home, workdir } = setup();
    const marker = "evil-patrol-marker-9f27.txt";
    const resp = validateResponsibility(makeRaw());
    const provider = fakeProvider([
        { toolCalls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: marker, content: "不该写" }) } }] },
        { content: "写操作被拒了。\n巡查结论：无发现" },
      ]);
    const result = await runPatrol(resp, {
        home, workdir, provider: provider as unknown as Provider,
      });
    expect(result.status).toMatch(/^completed/);
    expect(result.hasFindings).toBe(false);
    // 文件一个字节都没写进去。
    expect(existsSync(join(workdir, marker))).toBe(false);
    const [, events] = showTask(result.runId!, storeFor(home));
    const blocked = events.filter((e) => e.type === "patrol_write_blocked");
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked[0].tool).toBe("write_file");
    expect(String(blocked[0].reason)).toContain("unattended-readonly");
  });

test("ResponsibilitiesTest.test_run_due_one_failure_does_not_break_round", async () => {
    const { home, workdir } = setup();
    const data = {
      responsibilities: [
        validateResponsibility(makeRaw({ name: "总挂的责任", last_check: "2026-11-20T08:00:00Z" })),
        validateResponsibility(makeRaw({ name: "好的责任", goal: "看看磁盘", every_seconds: 60, last_check: "2026-11-20T08:00:00Z" })),
      ],
    };
    let calls = 0;
    const flaky = {
      ...echoProvider("巡查结论：无发现"),
      chat: async (): Promise<Record<string, unknown>> => {
        calls += 1;
        if (calls === 1) throw new Error("boom-provider-9f27");
        return textReply("巡查结论：无发现");
      },
    } as unknown as Provider;
    const results = await runDueResponsibilities(data, {
        home, workdir, provider: flaky, now: new Date("2026-11-20T10:00:00Z"),
      });
    expect(results.length).toBe(2);
    expect(results[0].status).toBe("error");
    expect(results[0].runId).toBeNull();
    expect(results[1].status).toMatch(/^completed/);
    expect(results[1].hasFindings).toBe(false);
    expect(data.responsibilities[0].last_status).toBe("error");
    expect(data.responsibilities[1].last_status).toBe("completed_unverified");
  });

test("ResponsibilitiesTest.test_list_public_omits_goal", () => {
    const { home } = setup();
    saveResponsibilities({ responsibilities: [validateResponsibility(makeRaw())] }, responsibilitiesPath(home));
    const pub = listResponsibilitiesPublic(home);
    expect(pub.length).toBe(1);
    expect(pub[0].name).toBe("依赖安全更新");
    expect(pub[0]).not.toHaveProperty("goal");
    expect(pub[0]).toHaveProperty("every_seconds");
  });

test("GatewayResponsibilitiesTest.test_api_responsibilities_metadata_only", async () => {
    const home = mkdtempSync(join(tmpdir(), "nyra-gw-resp-"));
    const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-resp-wd-"));
    saveResponsibilities({ responsibilities: [validateResponsibility(makeRaw())] }, responsibilitiesPath(home));
    const gw = new Gateway({
        home, workdir, host: "127.0.0.1", port: 0, mode: "full",
        providerFactory: () => fakeProvider([{ content: "ok" }], { delayMs: 10 }),
        config: { mcp_enabled: false, fallback_enabled: false },
      });
    const info = await gw.start();
    try {
      const base = `http://127.0.0.1:${info.port}`;
      const res = await fetch(`${base}/api/responsibilities`, { headers: { "X-Nyra-Token": gw.token } });
      expect(res.status).toBe(200);
      const body = await res.json() as { responsibilities: Record<string, unknown>[] };
      expect(body.responsibilities.length).toBe(1);
      expect(body.responsibilities[0].name).toBe("依赖安全更新");
      expect(body.responsibilities[0]).not.toHaveProperty("goal");
      const noToken = await fetch(`${base}/api/responsibilities`);
      expect(noToken.status).toBe(403);
    } finally {
      await gw.stop();
    }
  });
