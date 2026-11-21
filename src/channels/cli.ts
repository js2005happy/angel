// src/channels/cli.ts — `nyra channels` 子命令（缺口 27）。
//
//   nyra channels start                     前台启动常驻网关（Ctrl+C 停）
//   nyra channels stop                      停掉网关
//   nyra channels status                    网关运行态 + 各渠道 token/绑定/路由计数
//   nyra channels health                    各渠道 kind 健康检查（token/适配器/轮询）
//   nyra channels bindings [list]           列出显式绑定（+ 隐式默认绑定说明）
//   nyra channels bindings add ...          加一条绑定
//   nyra channels bindings remove <id> --yes
//   nyra channels bindings show <id>
//   nyra channels explain --channel ... --chat ... --sender ... [--mention] [--group]
//
// 删除绑定要 --yes（破坏性操作不静默做）；加绑定先过 validateBindingInput，
// 不合规直接报错、不写账本。路由解释是离线回放，不读网关进程状态。
import { randomBytes } from "node:crypto";
import { loadConfig, resolveHome } from "../config.ts";
import { resolveDiscordToken, resolveSlackTokens, resolveTelegramToken, resolveWhatsAppCredentials } from "../bot/index.ts";
import type { BotChannel } from "../bot/types.ts";
import { channelKindFor, checkKindHealth, listChannelKinds } from "./kind.ts";
import {
  defaultBinding,
  defaultBindingId,
  explainRoute,
  loadBindingStore,
  saveBindingStore,
  validateBindingInput,
  type ChannelBinding,
} from "./bindings.ts";
import {
  buildChannelAdapter,
  ChannelGateway,
  gatewayPidPath,
  readGatewayPid,
  readGatewayStatusFile,
} from "./gateway.ts";
import { botPolicyFromConfig } from "../bot/types.ts";

const CHANNELS: BotChannel[] = ["telegram", "discord", "slack", "whatsapp"];

function parseArgs(argv: string[]): { positional: string[]; opts: Record<string, string | boolean> } {
  const positional: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) {
        opts[key.slice(0, eq)] = key.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function usage(): number {
  process.stdout.write(
    "用法：nyra channels <start|stop|status|health|bindings|explain>\n" +
    "  start                     前台启动常驻网关（Ctrl+C 停）\n" +
    "  stop                      停掉网关\n" +
    "  status                    网关运行态 + 各渠道 token/绑定/路由计数\n" +
    "  health                    各渠道 kind 健康检查\n" +
    "  bindings list             列出显式绑定\n" +
    "  bindings add --channel <渠道> --agent <Soul> [--chat <id|*>] [--sender <id|*>] [--sandbox strict|standard|open] [--admission open|allowlist] [--allowlist <id,id>] [--mention-only|--no-mention-only] [--voice-cloud] [--priority <0-100>] [--note <说明>] [--id <id>]\n" +
    "  bindings remove <id> --yes\n" +
    "  bindings show <id>\n" +
    "  explain --channel <渠道> --chat <id> --sender <id> [--mention] [--group]\n",
  );
  return 1;
}

function channelOrNull(value: unknown): BotChannel | null {
  return value === "telegram" || value === "discord" || value === "slack" || value === "whatsapp" ? value : null;
}

function tokenPresent(channel: BotChannel, home: string): boolean {
  if (channel === "telegram") return resolveTelegramToken(home).token !== null;
  if (channel === "discord") return resolveDiscordToken(home).token !== null;
  if (channel === "slack") {
    const t = resolveSlackTokens(home);
    return !!(t.appToken && t.botToken);
  }
  const c = resolveWhatsAppCredentials(home);
  return !!(c.token && c.phoneNumberId);
}

async function handleStart(home: string): Promise<number> {
  const config = loadConfig(home);
  const gateway = new ChannelGateway({ home, workdir: process.cwd(), config });
  try {
    await gateway.start();
  } catch (err) {
    process.stderr.write(`渠道网关启动失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const st = gateway.status();
  const started = st.channels.filter((c) => c.started);
  if (started.length === 0) {
    gateway.stop();
    process.stderr.write("渠道网关没有启动任何渠道：先配 token（跑 nyra channels health 看缺什么）。\n");
    return 1;
  }
  process.stdout.write(`渠道网关已启动（pid ${process.pid}）：${started.map((c) => c.channel).join("、")}，Ctrl+C 停止。\n`);
  await gateway.waitStopped();
  process.stdout.write("渠道网关已停止。\n");
  return 0;
}

async function handleStop(home: string): Promise<number> {
  const pid = readGatewayPid(home);
  if (pid === null) {
    process.stdout.write("渠道网关未运行。\n");
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    process.stderr.write(`停网关失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  // 等进程退出（最多 5 秒）；超时只报，不强杀——网关自己会在 SIGTERM 里收尾。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      process.stdout.write(`渠道网关已停止（pid ${pid}）。\n`);
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stderr.write(`渠道网关（pid ${pid}）5 秒内没退出，请检查。\n`);
  return 1;
}

function handleStatus(home: string): number {
  const pid = readGatewayPid(home);
  const statusFile = readGatewayStatusFile(home);
  process.stdout.write(`渠道网关：${pid !== null ? `运行中（pid ${pid}）` : "未运行"}（pidfile：${gatewayPidPath(home)}）\n`);
  const config = loadConfig(home);
  const policy = botPolicyFromConfig(config);
  let store;
  try {
    store = loadBindingStore(home);
  } catch (err) {
    process.stderr.write(`绑定账本读失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  for (const channel of CHANNELS) {
    const kind = channelKindFor(channel);
    const explicit = store.bindings.filter((b) => b.channel === channel && b.enabled);
    const live = statusFile?.channels.find((c) => c.channel === channel);
    const started = live?.started ?? false;
    const routed = live?.routed ?? 0;
    const dropped = live?.dropped ?? 0;
    const errors = live?.errors ?? 0;
    const lastPoll = live?.lastPollAt ? `最近轮询 ${live.lastPollAt}` : "还没轮询过";
    process.stdout.write(
      `${kind.title}：${started ? "运行中" : "未运行"}，token：${tokenPresent(channel, home) ? "已配" : "未配"}，` +
      `显式绑定 ${explicit.length} 条（没命中时落到默认绑定 ${defaultBindingId(channel)}，agent ${policy.agent}），` +
      `已路由 ${routed} 条、已丢弃 ${dropped} 条、出错 ${errors} 条，${lastPoll}\n`,
    );
  }
  return 0;
}

function handleHealth(home: string): number {
  const statusFile = readGatewayStatusFile(home);
  let store;
  try {
    store = loadBindingStore(home);
  } catch (err) {
    process.stderr.write(`绑定账本读失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  let worst = 0;
  for (const kind of listChannelKinds()) {
    const explicit = store.bindings.filter((b) => b.channel === kind.kind && b.enabled);
    const live = statusFile?.channels.find((c) => c.channel === kind.kind);
    const tokenOk = tokenPresent(kind.kind, home);
    let adapterOk = false;
    if (tokenOk) {
      try { adapterOk = buildChannelAdapter(kind.kind, home) !== null; } catch { adapterOk = false; }
    }
    const health = checkKindHealth(kind, {
      tokenPresent: tokenOk,
      adapterOk,
      lastPollOk: live?.lastPollOk ?? null,
      bindings: explicit.length,
    });
    if (health.status === "error") worst = 2;
    else if (health.status === "degraded" && worst < 1) worst = 1;
    process.stdout.write(`${kind.title}：${health.status}（显式绑定 ${health.bindings} 条）\n`);
    for (const entry of health.entries) {
      process.stdout.write(`  ${entry.name}：${entry.status}——${entry.detail}\n`);
    }
    if (kind.environment.needsPublicUrl) process.stdout.write(`  注意：${kind.environment.notes}\n`);
  }
  return worst;
}

function formatBinding(b: ChannelBinding): string {
  const mention = b.mentionOnly === null ? "默认" : b.mentionOnly ? "只 @ " : "全收";
  return `${b.id}  ${b.channel}  chat=${b.chat}  sender=${b.sender}  agent=${b.agent}  ` +
    `sandbox=${b.sandbox}  admission=${b.admission}${b.allowlist.length ? `(${b.allowlist.join(",")})` : ""}  ` +
    `mention=${mention}  voiceCloud=${b.voiceCloud ? "开" : "关"}  priority=${b.priority}  ${b.enabled ? "启用" : "停用"}${b.note ? `  ${b.note}` : ""}`;
}

function handleBindings(argv: string[], home: string): number {
  const { positional, opts } = parseArgs(argv);
  const sub = positional[0] ?? "list";
  let store;
  try {
    store = loadBindingStore(home);
  } catch (err) {
    process.stderr.write(`绑定账本读失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (sub === "list") {
    if (store.bindings.length === 0) {
      process.stdout.write("没有显式绑定：所有渠道的消息都落到隐式默认绑定（agent 取 config bot.agent，沙箱 standard，准入 open）。\n");
    } else {
      for (const b of store.bindings) process.stdout.write(`${formatBinding(b)}\n`);
    }
    const config = loadConfig(home);
    const policy = botPolicyFromConfig(config);
    for (const channel of CHANNELS) {
      const d = defaultBinding(channel, policy.agent);
      process.stdout.write(`默认：${formatBinding(d)}\n`);
    }
    return 0;
  }
  if (sub === "add") {
    const channel = channelOrNull(opts.channel);
    if (!channel) {
      process.stderr.write("加绑定须指定 --channel <telegram|discord|slack|whatsapp>。\n");
      return 1;
    }
    const id = typeof opts.id === "string" && opts.id ? opts.id : `bd-${randomBytes(4).toString("hex")}`;
    const allowlist = typeof opts.allowlist === "string" && opts.allowlist
      ? opts.allowlist.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const mentionOnly = opts["mention-only"] === true ? true : opts["no-mention-only"] === true ? false : null;
    const now = new Date().toISOString();
    const input: Record<string, unknown> = {
      id,
      channel,
      chat: typeof opts.chat === "string" && opts.chat ? opts.chat : "*",
      sender: typeof opts.sender === "string" && opts.sender ? opts.sender : "*",
      agent: opts.agent,
      sandbox: typeof opts.sandbox === "string" && opts.sandbox ? opts.sandbox : "standard",
      admission: typeof opts.admission === "string" && opts.admission ? opts.admission : "open",
      allowlist,
      mentionOnly,
      voiceCloud: opts["voice-cloud"] === true,
      enabled: true,
      priority: typeof opts.priority === "string" ? Number(opts.priority) : 0,
      note: typeof opts.note === "string" ? opts.note : "",
      createdAt: now,
      updatedAt: now,
    };
    const errors = validateBindingInput(input);
    if (errors.length > 0) {
      for (const e of errors) process.stderr.write(`${e}\n`);
      return 1;
    }
    if (store.bindings.some((b) => b.id === id)) {
      process.stderr.write(`绑定 id 已存在：${id}（换一个 --id 再试）。\n`);
      return 1;
    }
    store.bindings.push(input as unknown as ChannelBinding);
    saveBindingStore(home, store);
    process.stdout.write(`已加绑定：${formatBinding(input as unknown as ChannelBinding)}\n`);
    process.stdout.write("注意：网关要重启才认新绑定（nyra channels stop 后再 start）。\n");
    return 0;
  }
  if (sub === "remove") {
    const id = positional[1];
    if (!id) {
      process.stderr.write("删绑定须指定 id：nyra channels bindings remove <id> --yes\n");
      return 1;
    }
    if (opts.yes !== true) {
      process.stderr.write("删绑定是破坏性操作，加 --yes 确认：nyra channels bindings remove <id> --yes\n");
      return 1;
    }
    const idx = store.bindings.findIndex((b) => b.id === id);
    if (idx < 0) {
      process.stderr.write(`找不到绑定：${id}\n`);
      return 1;
    }
    store.bindings.splice(idx, 1);
    saveBindingStore(home, store);
    process.stdout.write(`已删绑定：${id}\n`);
    process.stdout.write("注意：网关要重启才认删除（nyra channels stop 后再 start）。\n");
    return 0;
  }
  if (sub === "show") {
    const id = positional[1];
    if (!id) {
      process.stderr.write("看绑定须指定 id：nyra channels bindings show <id>\n");
      return 1;
    }
    const b = store.bindings.find((x) => x.id === id);
    if (!b) {
      process.stderr.write(`找不到绑定：${id}\n`);
      return 1;
    }
    const kind = channelKindFor(b.channel);
    process.stdout.write(`${formatBinding(b)}\n`);
    process.stdout.write(`kind 默认：群里${kind.policy.mentionDefault ? "只响应 @" : "全响应"}；${kind.policy.admission}\n`);
    return 0;
  }
  process.stderr.write(`未知的 bindings 子命令：${sub}（list/add/remove/show）\n`);
  return 1;
}

function handleExplain(argv: string[], home: string): number {
  const { opts } = parseArgs(argv);
  const channel = channelOrNull(opts.channel);
  if (!channel) {
    process.stderr.write("explain 须指定 --channel <telegram|discord|slack|whatsapp>。\n");
    return 1;
  }
  if (typeof opts.chat !== "string" || !opts.chat || typeof opts.sender !== "string" || !opts.sender) {
    process.stderr.write("explain 须指定 --chat <聊天 id> 与 --sender <发送者 id>。\n");
    return 1;
  }
  let store;
  try {
    store = loadBindingStore(home);
  } catch (err) {
    process.stderr.write(`绑定账本读失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const config = loadConfig(home);
  const policy = botPolicyFromConfig(config);
  const bindings = [...store.bindings, defaultBinding(channel, policy.agent)];
  const explanation = explainRoute(
    {
      channel,
      chat: opts.chat,
      sender: opts.sender,
      mentioned: opts.mention === true,
      isGroup: opts.group === true,
    },
    bindings,
  );
  process.stdout.write(`结论：${explanation.outcome}（${explanation.bindingId}，规则 ${explanation.rule}）——${explanation.reason}\n`);
  process.stdout.write("候选（按匹配排序）：\n");
  for (const c of explanation.candidates) {
    process.stdout.write(`  ${c.bindingId}：${c.matched ? "命中" : "不命中"}，具体程度 ${c.specificity} 分，priority ${c.priority}，准入 ${c.admission || "—"}\n`);
  }
  return 0;
}

/** `nyra channels ...`：常驻多渠道网关 + 绑定管理 + 路由解释。 */
export async function handleChannels(argv: string[], home: string): Promise<number> {
  const resolvedHome = home || resolveHome();
  const sub = argv[0];
  if (!sub) return usage();
  if (sub === "start") return handleStart(resolvedHome);
  if (sub === "stop") return handleStop(resolvedHome);
  if (sub === "status") return handleStatus(resolvedHome);
  if (sub === "health") return handleHealth(resolvedHome);
  if (sub === "bindings") return handleBindings(argv.slice(1), resolvedHome);
  if (sub === "explain") return handleExplain(argv.slice(1), resolvedHome);
  process.stderr.write(`未知的 channels 子命令：${sub}\n`);
  return usage();
}
