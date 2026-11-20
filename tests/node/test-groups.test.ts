// tests/node/test-groups.test.ts — 对应 tests/test_group_chat.py 的 Node 移植。
// 全部 mock provider，不调真实模型、不联网。
import { test, expect } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GroupError,
  GroupStore,
  MAX_BOTS,
  MAX_ROUNDS,
  parseBot,
  type Bot,
  type BotConfig,
  type ProviderFactory,
} from "../../src/groups.ts";
import {
  KeyRotatingProvider,
  ProviderError,
  type ProviderLike,
} from "../../src/providers.ts";
import { Vault } from "../../src/vault.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "nyra-groups-"));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

type Outcome = string | Error;

function mockProvider(
  name: string,
  outcomes: Outcome[],
  opts?: { delayMs?: number; redactSecrets?: string[] },
): ProviderLike & { calls: number; seenMessages: unknown[][] } {
  let calls = 0;
  const seenMessages: unknown[][] = [];
  const provider = {
    name,
    model: `${name}-model`,
    baseUrl: `https://${name}.example.com/v1`,
    calls: 0,
    seenMessages,
    hasCredentials: () => true,
    async chat(messages: unknown[]): Promise<Record<string, unknown>> {
      if (opts?.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      calls += 1;
      provider.calls = calls;
      seenMessages.push(messages as unknown[]);
      const outcome = outcomes[Math.min(calls - 1, outcomes.length - 1)];
      if (outcome instanceof Error) throw outcome;
      return {
        choices: [{ message: { role: "assistant", content: outcome as string } }],
      };
    },
    async listModels(): Promise<string[]> {
      return [`${name}-model`];
    },
    redact: (text: string) => {
      let out = text;
      for (const secret of opts?.redactSecrets ?? []) {
        out = out.split(secret).join("[已隐藏]");
      }
      return out;
    },
  };
  return provider;
}

/** 每个 bot 一句独立意见的 SpyProvider（对应 Python SpyProvider）。 */
function spyFactory(seen: Map<string, ProviderLike & { calls: number }>): ProviderFactory {
  return (bot: Bot) => {
    const provider = mockProvider(bot.id, [`${bot.id} 独立意见`]);
    seen.set(bot.id, provider);
    return provider;
  };
}

function twoBots(): BotConfig[] {
  return [
    { id: "bot1", name: "One", role: "R", instructions: "Own ideas" },
    { id: "bot2", name: "Two", role: "R", instructions: "Own ideas" },
  ];
}

// ---- 房间读写往返 -------------------------------------------------------

test("create 默认 5 机器人并可 get/list 往返", () => {
  const root = tmpRoot();
  try {
    const store = new GroupStore(join(root, "groups"), { home: root });
    const room = store.create("dev", "开发群");
    expect(room.bots.length).toBe(5);
    expect(room.bots.map((b) => b.id)).toEqual(["lead", "architect", "builder", "reviewer", "verifier"]);
    expect(room.id).toBe("dev");
    expect(room.name).toBe("开发群");
    expect(room.instance_id).toMatch(/^[0-9a-f]{32}$/);
    expect(room.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    expect(room.messages).toEqual([]);
    expect(JSON.stringify(room)).not.toContain("api_keys");

    const again = store.get("dev");
    expect(again).toEqual(room);
    expect(store.listRooms()).toEqual([
      { id: "dev", name: "开发群", bots: 5, messages: 0 },
    ]);

    // 磁盘上的 room.json 与 Python 格式一致：indent 2、末尾换行、含全部字段。
    const raw = readFileSync(join(root, "groups", "dev", "room.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const stored = JSON.parse(raw) as Record<string, unknown>;
    expect(stored.id).toBe("dev");
    expect((stored.bots as unknown[]).length).toBe(5);
    expect(typeof stored.instance_id).toBe("string");
    // 文件 0600、目录 0700（Windows 没有 POSIX 权限位，不断言）。
    if (process.platform !== "win32") {
      expectPerms(join(root, "groups", "dev", "room.json"), 0o600);
      expectPerms(join(root, "groups", "dev"), 0o700);
    }
  } finally {
    cleanup(root);
  }
});

test("send 持久化，换 store 实例后历史仍在", async () => {
  const root = tmpRoot();
  try {
    const seen = new Map<string, ProviderLike & { calls: number }>();
    const factory = spyFactory(seen);
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: factory });
    store.create("dev", "开发群");
    const result = await store.send("dev", "设计一个小型 SaaS");
    expect(result.total).toBe(6);
    expect(result.messages.map((m) => m.sender)).toEqual([
      "user", "lead", "architect", "builder", "reviewer", "verifier",
    ]);
    expect(result.messages[1].content).toBe("lead 独立意见");
    // 各 bot 有独立工作目录与 session。
    for (const botId of ["lead", "architect", "builder", "reviewer", "verifier"]) {
      expect(existsSync(join(root, "groups", "dev", "bots", botId, "workspace"))).toBe(true);
      expect(existsSync(join(root, "sessions", `group-dev-${botId}.jsonl`))).toBe(true);
    }
    const store2 = new GroupStore(join(root, "groups"), { home: root, providerFactory: factory });
    expect(store2.listRooms()[0].messages).toBe(6);
    expect(store2.get("dev").messages).toEqual(result.messages);
    await store2.send("dev", "@lead 继续");
    expect(store2.get("dev").messages.length).toBe(8);
  } finally {
    cleanup(root);
  }
});

test("创建校验：坏 id、机器人数量、重复 id、非 readonly、重复建群", () => {
  const root = tmpRoot();
  try {
    const store = new GroupStore(join(root, "groups"), { home: root });
    for (const badId of ["../parent", "Uppercase", "/tmp", ""]) {
      expect(() => store.create(badId, "bad")).toThrow(GroupError);
    }
    expect(() => store.create("empty", "botless", [])).toThrow(GroupError);
    const bot = (i: number): BotConfig => ({
      id: `bot${i}`, name: "Bot", role: "Role", instructions: "Independent",
    });
    expect(() =>
      store.create("too-many", "too many", Array.from({ length: MAX_BOTS + 1 }, (_, i) => bot(i))),
    ).toThrow(GroupError);
    expect(() =>
      store.create("dup", "dup", [bot(1), bot(1)]),
    ).toThrow(GroupError);
    expect(() =>
      store.create("bad", "invalid", [
        { id: "one", name: "One", role: "Role", instructions: "Think", mode: "full" },
        { id: "two", name: "Two", role: "Role", instructions: "Think" },
      ]),
    ).toThrow(GroupError);
    store.create("dev", "开发群");
    expect(() => store.create("dev", "duplicate")).toThrow(GroupError);
    expect(store.listRooms().length).toBe(1);
  } finally {
    cleanup(root);
  }
});

test("@提及只路由给被提及的机器人", async () => {
  const root = tmpRoot();
  try {
    const seen = new Map<string, ProviderLike & { calls: number }>();
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: spyFactory(seen) });
    store.create("dev", "开发群");
    const result = await store.send("dev", "@architect 请提出独立方案");
    expect(result.messages.map((m) => m.sender)).toEqual(["user", "architect"]);
    expect([...seen.keys()]).toEqual(["architect"]);
  } finally {
    cleanup(root);
  }
});

test("未知提及不保存、不调用模型", async () => {
  const root = tmpRoot();
  try {
    const seen = new Map<string, ProviderLike & { calls: number }>();
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: spyFactory(seen) });
    store.create("dev", "开发群");
    await expect(store.send("dev", "@unknown 请回答")).rejects.toThrow(GroupError);
    expect(store.get("dev").messages).toEqual([]);
    expect(seen.size).toBe(0);
  } finally {
    cleanup(root);
  }
});

test("多轮有上限，轮次顺序与 Python 一致", async () => {
  const root = tmpRoot();
  try {
    const seen = new Map<string, ProviderLike & { calls: number }>();
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: spyFactory(seen) });
    store.create("dev", "开发群", twoBots());
    const result = await store.send("dev", "@bot1 @bot2 讨论测试", 2);
    expect(result.messages.map((m) => m.sender)).toEqual([
      "user", "bot1", "bot2", "bot1", "bot2",
    ]);
    for (const invalid of [0, 3, true, "1"]) {
      await expect(store.send("dev", "Hello", invalid as never)).rejects.toThrow(GroupError);
    }
    expect(store.get("dev").messages).toEqual(result.messages);
    expect(MAX_ROUNDS).toBe(2);
  } finally {
    cleanup(root);
  }
});

test("空回复变（无回复），超长回复截断到 6000 字符", async () => {
  const root = tmpRoot();
  try {
    const factory: ProviderFactory = (bot) =>
      mockProvider(bot.id, [bot.id === "bot1" ? "" : "x".repeat(7000)]);
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: factory });
    store.create("dev", "开发群", twoBots());
    const result = await store.send("dev", "说点什么");
    expect(result.messages[1].content).toBe("（无回复）");
    expect(result.messages[2].content.length).toBe(6000);
  } finally {
    cleanup(root);
  }
});

// ---- Key 上限与增删 ------------------------------------------------------

test("Bot.parse：Key 上限 5、空 Key、非列表都拒绝；无 Key 的旧房间仍可用", () => {
  expect(() =>
    parseBot({
      id: "b1", name: "One", role: "R", instructions: "Own ideas",
      api_keys: ["k1", "k2", "k3", "k4", "k5", "k6"],
    }),
  ).toThrow(GroupError);
  for (const bad of [[""], ["   "], ["k1", 123], "k1"]) {
    expect(() =>
      parseBot({
        id: "b1", name: "One", role: "R", instructions: "Own ideas", api_keys: bad,
      }),
    ).toThrow(GroupError);
  }
  expect(parseBot({ id: "b1", name: "One", role: "R", instructions: "Own ideas" }).api_keys).toBeNull();
  expect(
    parseBot({
      id: "b1", name: "One", role: "R", instructions: "Own ideas",
      api_keys: ["k1", "k2", "k3", "k4", "k5"],
    }).api_keys,
  ).toEqual(["k1", "k2", "k3", "k4", "k5"]);
});

test("增删 Key：满 5 把拒绝增、按值/下标删、删不存在的报错", () => {
  const root = tmpRoot();
  try {
    const store = new GroupStore(join(root, "groups"), { home: root });
    store.create("dev", "开发群", [
      { id: "bot1", name: "One", role: "R", instructions: "Own ideas", api_keys: ["k1"] },
      { id: "bot2", name: "Two", role: "R", instructions: "Own ideas" },
    ]);
    store.addApiKey("dev", "bot1", "k2");
    store.addApiKey("dev", "bot1", "k3");
    store.addApiKey("dev", "bot1", "k4");
    store.addApiKey("dev", "bot1", "k5");
    expect(() => store.addApiKey("dev", "bot1", "k6")).toThrow(GroupError);
    expect(() => store.addApiKey("dev", "bot1", "  ")).toThrow(GroupError);
    store.removeApiKey("dev", "bot1", "k3");
    store.removeApiKey("dev", "bot1", 0);
    const stored = JSON.parse(
      readFileSync(join(root, "groups", "dev", "room.json"), "utf-8"),
    ) as { bots: { id: string; api_keys: string[] | null; api_keys_enc: string[] | null }[] };
    // 磁盘上只剩加密串，明文 Key 已不在 room.json 里；解析后仍是同一组 Key。
    expect(stored.bots[0].api_keys).toBeNull();
    expect(store.resolveBotKeys(parseBot(stored.bots[0]))).toEqual(["k2", "k4", "k5"]);
    expect(() => store.removeApiKey("dev", "bot1", "nope")).toThrow(GroupError);
    expect(() => store.removeApiKey("dev", "bot1", 99)).toThrow(GroupError);
    expect(() => store.removeApiKey("dev", "ghost", "k2")).toThrow(GroupError);
    store.replaceApiKeys("dev", "bot1", null);
    const cleared = JSON.parse(
      readFileSync(join(root, "groups", "dev", "room.json"), "utf-8"),
    ) as { bots: { api_keys: string[] | null; api_keys_enc: string[] | null }[] };
    expect(cleared.bots[0].api_keys).toBeNull();
    expect(cleared.bots[0].api_keys_enc).toBeNull();
  } finally {
    cleanup(root);
  }
});

// ---- Key 隔离与轮换 ------------------------------------------------------

test("不同机器人 Key 隔离：factory 各自只看到自己的 Key", async () => {
  const root = tmpRoot();
  try {
    const seenKeys = new Map<string, string[] | null>();
    let store!: GroupStore;
    const factory: ProviderFactory = (bot) => {
      seenKeys.set(bot.id, store.resolveBotKeys(bot));
      return mockProvider(bot.id, [`${bot.id} 答复`]);
    };
    store = new GroupStore(join(root, "groups"), { home: root, providerFactory: factory });
    store.create("dev", "开发群", [
      { id: "bot1", name: "One", role: "R", instructions: "Own ideas", provider: "deepseek", api_keys: ["k1a", "k1b"] },
      { id: "bot2", name: "Two", role: "R", instructions: "Own ideas", provider: "deepseek", api_keys: ["k2a"] },
    ]);
    await store.send("dev", "都发表自己的意见");
    expect(seenKeys.get("bot1")).toEqual(["k1a", "k1b"]);
    expect(seenKeys.get("bot2")).toEqual(["k2a"]);
    const all = [...(seenKeys.get("bot1") ?? []), ...(seenKeys.get("bot2") ?? [])];
    expect(new Set(all).size).toBe(all.length);
  } finally {
    cleanup(root);
  }
});

test("轮换：401 后切第二把 Key 成功，model_switches 记在 bot 记录上", async () => {
  const root = tmpRoot();
  try {
    const factory: ProviderFactory = (bot) => {
      const first = mockProvider(bot.id, [
        new ProviderError("认证失败", { status: 401, kind: "auth" }),
      ]);
      const second = mockProvider(bot.id, ["第二把 key 答复"]);
      return new KeyRotatingProvider([first, second]);
    };
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: factory });
    store.create("dev", "开发群", twoBots());
    const result = await store.send("dev", "@bot1 请回答");
    const entry = result.messages[1];
    expect(entry.sender).toBe("bot1");
    expect(entry.content).toBe("第二把 key 答复");
    expect(entry.model_switches?.length).toBe(1);
    expect(entry.model_switches?.[0].from).toBe(`${"bot1"} key 1`);
    expect(entry.model_switches?.[0].to).toBe(`${"bot1"} key 2`);
    expect(entry.model_switches?.[0].kind).toBe("auth");
    expect("model_switches" in result.messages[0]).toBe(false);
  } finally {
    cleanup(root);
  }
});

test("轮换：全部 Key 失败记 error 记录，Key 值不泄露", async () => {
  const root = tmpRoot();
  try {
    const factory: ProviderFactory = (bot) => {
      const leaky = (key: string) =>
        mockProvider(bot.id, [new ProviderError(`server said bad key ${key}`, { status: 401, kind: "auth" })], {
          redactSecrets: [key],
        });
      return new KeyRotatingProvider([leaky("sk-secret-AAA"), leaky("sk-secret-BBB")]);
    };
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: factory });
    store.create("dev", "开发群", twoBots());
    const result = await store.send("dev", "@bot1 请回答");
    const entry = result.messages[1];
    expect(entry.error).toBe(true);
    expect(entry.content.startsWith("机器人执行失败：")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-secret-AAA");
    expect(JSON.stringify(result)).not.toContain("sk-secret-BBB");
    expect(JSON.stringify(result)).toContain("key 1");
  } finally {
    cleanup(root);
  }
});

test("keyRotatingProvider：每 bot 独立建池，Key 值与顺序与 room.json 一致", () => {
  const root = tmpRoot();
  try {
    const store = new GroupStore(join(root, "groups"), { home: root });
    const bot1: Bot = parseBot({
      id: "bot1", name: "One", role: "R", instructions: "Own ideas",
      provider: "deepseek", model: "deepseek-flash", api_keys: ["k1a", "k1b"],
    });
    const bot2: Bot = parseBot({
      id: "bot2", name: "Two", role: "R", instructions: "Own ideas",
      provider: "deepseek", model: "deepseek-flash", api_keys: ["k2a"],
    });
    const p1 = store.keyRotatingProvider(bot1) as KeyRotatingProvider;
    const p2 = store.keyRotatingProvider(bot2) as KeyRotatingProvider;
    expect(p1).toBeInstanceOf(KeyRotatingProvider);
    expect(p1.providers.map((p) => (p as { apiKey?: string }).apiKey)).toEqual(["k1a", "k1b"]);
    expect(p2.providers.map((p) => (p as { apiKey?: string }).apiKey)).toEqual(["k2a"]);
    expect(p1.providers).not.toBe(p2.providers);
    // CLI provider 配 Key 直接拒绝（与 Python _key_rotating_provider 一致）。
    const cliBot: Bot = parseBot({
      id: "lead", name: "组长", role: "R", instructions: "Own ideas",
      provider: "codex", model: "codex-model", api_keys: ["k1"],
    });
    expect(() => store.keyRotatingProvider(cliBot)).toThrow(GroupError);
  } finally {
    cleanup(root);
  }
});

test("Key 永不出现在返回数据里，磁盘上只存加密串", async () => {
  const root = tmpRoot();
  try {
    const seen = new Map<string, ProviderLike & { calls: number }>();
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: spyFactory(seen) });
    const bots = [
      { id: "bot1", name: "One", role: "R", instructions: "Own ideas", provider: "deepseek", api_keys: ["sk-lead-111"] },
      { id: "bot2", name: "Two", role: "R", instructions: "Own ideas", provider: "deepseek", api_keys: ["sk-arch-222", "sk-arch-333"] },
    ];
    const created = store.create("dev", "开发群", bots);
    for (const room of [created, store.get("dev")]) {
      expect(JSON.stringify(room)).not.toContain("api_keys");
      expect(JSON.stringify(room)).not.toContain("sk-lead-111");
      expect(JSON.stringify(room)).not.toContain("sk-arch-222");
    }
    const roomText = readFileSync(join(root, "groups", "dev", "room.json"), "utf-8");
    expect(roomText).not.toContain("sk-lead-111");
    expect(roomText).not.toContain("sk-arch-222");
    expect(roomText).not.toContain("sk-arch-333");
    const stored = JSON.parse(roomText) as { bots: { api_keys: string[] | null; api_keys_enc: string[] | null }[] };
    expect(stored.bots[0].api_keys).toBeNull();
    expect(stored.bots[0].api_keys_enc?.[0]).toMatch(/^v1:local:/);
    expect(stored.bots[1].api_keys_enc).toHaveLength(2);
    expect(store.resolveBotKeys(parseBot(stored.bots[0]))).toEqual(["sk-lead-111"]);
    expect(store.resolveBotKeys(parseBot(stored.bots[1]))).toEqual(["sk-arch-222", "sk-arch-333"]);
    const result = await store.send("dev", "@bot1 请回答");
    expect(JSON.stringify(result)).not.toContain("sk-lead-111");
  } finally {
    cleanup(root);
  }
});

// ---- 损坏 room.json 的容错 -------------------------------------------------

test("损坏 room.json：get 报 GroupError，list 跳过，缺失/id 错各有其错", async () => {
  const root = tmpRoot();
  try {
    const store = new GroupStore(join(root, "groups"), { home: root });
    expect(() => store.get("ghost")).toThrow(GroupError);
    expect(() => store.get("ghost")).toThrow(/不存在/);
    store.create("good", "好群");
    store.create("bad", "坏群");
    store.create("wrong", "错群");
    writeFileSync(join(root, "groups", "bad", "room.json"), "{not json", "utf-8");
    writeFileSync(
      join(root, "groups", "wrong", "room.json"),
      JSON.stringify({ id: "someone-else", name: "x", bots: [], messages: [] }),
      "utf-8",
    );
    expect(() => store.get("bad")).toThrow(/数据无法读取/);
    expect(() => store.get("wrong")).toThrow(/格式无效/);
    await expect(store.send("bad", "hi")).rejects.toThrow(GroupError);
    // list_rooms 只返回好的那间。
    expect(store.listRooms().map((r) => r.id)).toEqual(["good"]);
    // 空根目录返回 []。
    const empty = new GroupStore(join(root, "nope"), { home: root });
    expect(empty.listRooms()).toEqual([]);
  } finally {
    cleanup(root);
  }
});

// ---- 超时与并行 -----------------------------------------------------------

test("超时：一个 bot 挂起不拖垮整轮，其他 bot 正常回、挂起的记 error", async () => {
  const root = tmpRoot();
  try {
    const factory: ProviderFactory = (bot) =>
      mockProvider(bot.id, [`${bot.id} 答复`], {
        delayMs: bot.id === "bot1" ? 2000 : 0,
      });
    const store = new GroupStore(join(root, "groups"), {
      home: root,
      providerFactory: factory,
      botTimeoutSeconds: 0.2,
    });
    store.create("dev", "开发群", twoBots());
    const started = Date.now();
    const result = await store.send("dev", "都回答");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1500);
    expect(result.messages.map((m) => m.sender)).toEqual(["user", "bot1", "bot2"]);
    expect(result.messages[1].error).toBe(true);
    expect(result.messages[1].content).toBe("机器人执行失败（TimeoutError）");
    expect(result.messages[2].content).toBe("bot2 答复");
    expect(result.total).toBe(3);
  } finally {
    cleanup(root);
  }
});

test("并行：两 bot 各慢 500ms，总耗时远小于串行 1000ms", async () => {
  const root = tmpRoot();
  try {
    const factory: ProviderFactory = (bot) =>
      mockProvider(bot.id, [`${bot.id} 答复`], { delayMs: 500 });
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: factory });
    store.create("dev", "开发群", twoBots());
    const started = Date.now();
    const result = await store.send("dev", "都回答");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(900);
    expect(result.messages.map((m) => m.sender)).toEqual(["user", "bot1", "bot2"]);
    expect(result.messages[1].content).toBe("bot1 答复");
    expect(result.messages[2].content).toBe("bot2 答复");
  } finally {
    cleanup(root);
  }
});

test("模型抛错记 error 记录，不中断其他 bot", async () => {
  const root = tmpRoot();
  try {
    const factory: ProviderFactory = (bot) =>
      bot.id === "bot1"
        ? mockProvider(bot.id, [new Error("boom")])
        : mockProvider(bot.id, ["bot2 答复"]);
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: factory });
    store.create("dev", "开发群", twoBots());
    const result = await store.send("dev", "都回答");
    expect(result.messages[1].error).toBe(true);
    expect(result.messages[1].content).toBe("机器人执行失败（Error）");
    expect(result.messages[2].content).toBe("bot2 答复");
    expect(result.total).toBe(3);
  } finally {
    cleanup(root);
  }
});

test("无凭证的 bot 记 error 记录：模型凭证未配置", async () => {
  const root = tmpRoot();
  try {
    const factory: ProviderFactory = (bot) => {
      const p = mockProvider(bot.id, ["答复"]);
      if (bot.id === "bot1") p.hasCredentials = () => false;
      return p;
    };
    const store = new GroupStore(join(root, "groups"), { home: root, providerFactory: factory });
    store.create("dev", "开发群", twoBots());
    const result = await store.send("dev", "都回答");
    expect(result.messages[1].error).toBe(true);
    expect(result.messages[1].content).toBe("机器人执行失败：模型凭证未配置");
    expect(result.messages[2].content).toBe("答复");
  } finally {
    cleanup(root);
  }
});

test("不存在的群 send 报不存在", async () => {
  const root = tmpRoot();
  try {
    const store = new GroupStore(join(root, "groups"), { home: root });
    await expect(store.send("ghost", "hi")).rejects.toThrow(/不存在/);
  } finally {
    cleanup(root);
  }
});

// -- 0.4.1 审查 12 项：第 7 项（群 Key 加密存储） --
test("Groups041Test.test_legacy_plaintext_keys_migrated_on_read", () => {
  const root = tmpRoot();
  try {
    const store = new GroupStore(join(root, "groups"), { home: root });
    // 手写一个旧版 room.json：明文 api_keys。
    const dir = join(root, "groups", "dev");
    mkdirSync(dir, { recursive: true });
    const legacy = {
      id: "dev", name: "开发群",
      bots: [{ id: "bot1", name: "One", role: "R", instructions: "Own ideas", provider: null, model: null, api_keys: ["sk-old-111"], mode: "readonly" }],
      messages: [], created_at: "2026-11-19T07:00:00+00:00", instance_id: "aabbccddeeff00112233445566778899",
    };
    writeFileSync(join(dir, "room.json"), JSON.stringify(legacy, null, 2), "utf-8");
    // 读一次即迁移：Key 还能用，磁盘上不再有明文。
    const room = store.get("dev");
    expect(JSON.stringify(room)).not.toContain("sk-old-111");
    const text = readFileSync(join(dir, "room.json"), "utf-8");
    expect(text).not.toContain("sk-old-111");
    const stored = JSON.parse(text) as { bots: { api_keys: string[] | null; api_keys_enc: string[] | null }[] };
    expect(stored.bots[0].api_keys).toBeNull();
    expect(stored.bots[0].api_keys_enc?.[0]).toMatch(/^v1:local:/);
    expect(store.resolveBotKeys(parseBot(stored.bots[0]))).toEqual(["sk-old-111"]);
  } finally {
    cleanup(root);
  }
});

test("Groups041Test.test_keys_encrypted_via_vault_when_available", () => {
  const root = tmpRoot();
  try {
    const vault = new Vault(join(root, "vault.json"));
    vault.init("master-pass");
    const saved = process.env.NYRA_VAULT_PASSWORD;
    process.env.NYRA_VAULT_PASSWORD = "master-pass";
    try {
      const store = new GroupStore(join(root, "groups"), { home: root });
      store.create("dev", "开发群", [
        { id: "bot1", name: "One", role: "R", instructions: "Own ideas", provider: "deepseek", api_keys: ["sk-vault-111"] },
        { id: "bot2", name: "Two", role: "R", instructions: "Own ideas", provider: "deepseek" },
      ]);
      const text = readFileSync(join(root, "groups", "dev", "room.json"), "utf-8");
      expect(text).not.toContain("sk-vault-111");
      const stored = JSON.parse(text) as { bots: { api_keys_enc: string[] | null }[] };
      expect(stored.bots[0].api_keys_enc?.[0]).toMatch(/^v1:vault:group-/);
      expect(store.resolveBotKeys(parseBot(stored.bots[0]))).toEqual(["sk-vault-111"]);
      // 密码箱里确实有这条；删 Key 后对应的密码箱条目也被尽力删掉。
      expect(vault.listNames().some((n) => n.startsWith("group-"))).toBe(true);
      store.removeApiKey("dev", "bot1", "sk-vault-111");
      const reopened = new Vault(join(root, "vault.json"));
      expect(reopened.unlock("master-pass")).toBe(true);
      expect(reopened.listNames().some((n) => n.startsWith("group-"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.NYRA_VAULT_PASSWORD;
      else process.env.NYRA_VAULT_PASSWORD = saved;
    }
  } finally {
    cleanup(root);
  }
});

test("Groups041Test.test_undecryptable_keys_report_clear_error", () => {
  const root = tmpRoot();
  try {
    const store = new GroupStore(join(root, "groups"), { home: root });
    const dir = join(root, "groups", "dev");
    mkdirSync(dir, { recursive: true });
    const room = {
      id: "dev", name: "开发群",
      bots: [{ id: "bot1", name: "One", role: "R", instructions: "Own ideas", provider: "deepseek", model: "deepseek-flash", api_keys: null, api_keys_enc: ["v1:local:00:00:00"], mode: "readonly" }],
      messages: [], created_at: "2026-11-19T07:00:00+00:00", instance_id: "aabbccddeeff00112233445566778899",
    };
    writeFileSync(join(dir, "room.json"), JSON.stringify(room, null, 2), "utf-8");
    const bot = parseBot(room.bots[0]);
    // 解不出的 Key 不进轮换；providerForBot 说清楚原因，不静默当没配。
    expect(store.resolveBotKeys(bot)).toEqual([]);
    expect(() => store.providerForBot(bot)).toThrow(/无法解密/);
  } finally {
    cleanup(root);
  }
});

// ---- 群聊沙箱（0.5.2 缺口收尾）：defaultBotRunner 透传沙箱配置 -----------

/** 第一次返回 shell 工具调用、第二次返回文本的 provider（驱动 defaultBotRunner 跑一次 shell）。 */
function shellCallingProvider(marker: string, seenMessages: unknown[][]): ProviderLike {
  let calls = 0;
  return {
    name: "shell-caller",
    model: "shell-caller-model",
    baseUrl: "https://shell-caller.example.com/v1",
    hasCredentials: () => true,
    async chat(messages: unknown[]): Promise<Record<string, unknown>> {
      calls += 1;
      seenMessages.push(messages as unknown[]);
      if (calls === 1) {
        return {
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: { name: "shell", arguments: JSON.stringify({ command: `touch "${marker}"` }) },
              }],
            },
          }],
        };
      }
      return { choices: [{ message: { role: "assistant", content: "做完了" } }] };
    },
    async listModels(): Promise<string[]> { return ["shell-caller-model"]; },
    redact: (t: string) => t,
  };
}

/**
 * 生产上 create() 只允许 readonly 机器人，执行型需单独授权——目前没有代码
 * 路径能改 mode。本测试直接改 room.json 模拟“已单独授权”的机器人，
 * 只验沙箱透传本身，不验授权流程。
 */
function authorizeExecution(root: string, botId: string): void {
  const file = join(root, "groups", "dev", "room.json");
  const room = JSON.parse(readFileSync(file, "utf-8")) as { bots: { id: string; mode: string }[] };
  for (const b of room.bots) if (b.id === botId) b.mode = "full";
  writeFileSync(file, JSON.stringify(room, null, 2) + "\n", "utf-8");
}

test("群聊沙箱：显式后端不可用时 fail-closed，命令不执行", async () => {
  const root = tmpRoot();
  try {
    const marker = join(root, "marker-bogus");
    const seen: unknown[][] = [];
    const factory: ProviderFactory = () => shellCallingProvider(marker, seen);
    const store = new GroupStore(join(root, "groups"), {
      home: root,
      providerFactory: factory,
      sandbox: { backend: "nonexistent-backend-xyz", mode: "workspace-write", allowNet: false },
    });
    store.create("dev", "开发群");
    authorizeExecution(root, "lead");
    const result = await store.send("dev", "@lead 跑个命令");
    expect(result.messages.length).toBeGreaterThan(0);
    // 沙箱配置透传到了机器人工具层：命令被拒绝执行，标记文件不存在；
    // 拒绝原因（后端名）回到了模型上下文，而不是静默成功。
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(seen)).toContain("nonexistent-backend-xyz");
  } finally {
    cleanup(root);
  }
});

test("群聊沙箱：local 后端正常执行命令", async () => {
  const root = tmpRoot();
  try {
    const marker = join(root, "marker-local");
    const seen: unknown[][] = [];
    const factory: ProviderFactory = () => shellCallingProvider(marker, seen);
    const store = new GroupStore(join(root, "groups"), {
      home: root,
      providerFactory: factory,
      sandbox: { backend: "local", mode: "workspace-write", allowNet: false },
    });
    store.create("dev", "开发群");
    authorizeExecution(root, "lead");
    await store.send("dev", "@lead 跑个命令");
    expect(existsSync(marker)).toBe(true);
  } finally {
    cleanup(root);
  }
});
