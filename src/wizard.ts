// src/wizard.ts — 首次启动向导（中文，三步到第一个任务）。
// 第 1 步：选模型来源（14 个 provider + 本地 Ollama / Codex，二选一的本地项排在前面）。
// 第 2 步：填 Key 或选本地。Key 绝不写进 config.json（与 Python 版一致）：
//   已在环境变量里的 Key 直接认；新填的 Key 只问用户要不要把 export 行追加进
//   shell rc（默认不追加），不同意就只打印 export 命令让用户自己跑。
// 第 3 步：跑一条本地示例任务（不调模型、无 Key 也能跑通）。
// 有 Key 时向导只保存配置，不强制跑模型任务（agent 核心在第 2 阶段移植）。
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDERS, lookupPreset, saveConfig, type ProviderPreset, type ResolvedProvider } from "./config.ts";
import { runExampleTask } from "./exampleTask.ts";

export interface WizardResult {
  provider: string;
  model: string;
  keyConfigured: boolean;
  exampleOk: boolean;
}

const LOCAL_FIRST = ["ollama", "codex"];

/** 向导里的 provider 顺序：本地项在前，内置 14 个，末尾跟用户自定义的。 */
export function providerOrder(config: Record<string, unknown>): string[] {
  const customNames = Object.keys((config.custom_providers as Record<string, unknown>) || {})
    .filter((n) => !PROVIDERS[n]);
  return [...LOCAL_FIRST, ...Object.keys(PROVIDERS).filter((n) => !LOCAL_FIRST.includes(n) && n !== "custom"), "custom", ...customNames];
}

/**
 * 逐行提问：用 'line' 事件 + 队列实现，而不是 rl.question()。
 * 原因：管道输入时所有行会瞬间到齐，rl.question() 只在提问瞬间挂监听，
 * 还没问到的行会被当成无人收听的 'line' 事件丢掉（实测：第 3 个回答丢失）。
 * 队列做法交互终端与管道输入都对：行先到就排队，问题先到就等下一行；
 * 输入关掉（EOF）且队列空时当作空回答继续走，不挂住。
 */
export function createAsker(rl: ReturnType<typeof createInterface>): {
  ask: (question: string) => Promise<string>;
  closed: () => boolean;
} {
  const queue: string[] = [];
  const waiters: ((value: string) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const value = line.trim();
    if (waiters.length > 0) waiters.shift()!(value);
    else queue.push(value);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!("");
  });
  return {
    ask(question: string): Promise<string> {
      (rl as unknown as { output: NodeJS.WriteStream }).output.write(question);
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve("");
      return new Promise((resolve) => waiters.push(resolve));
    },
    closed: () => closed,
  };
}

/** 用户 shell rc 文件（bash/zsh），追加 export 行时用；找不到就返回 null。 */
export function detectShellRc(): string | null {
  const shell = process.env.SHELL || "";
  const userHome = process.env.HOME || homedir();
  const candidates = shell.includes("zsh")
    ? [".zshrc", ".bashrc"]
    : [".bashrc", ".zshrc"];
  for (const name of candidates) {
    const p = join(userHome, name);
    if (existsSync(p)) return p;
  }
  return join(userHome, candidates[0]);
}

export async function runWizard(opts: {
  home: string;
  provider: ResolvedProvider;
  config: Record<string, unknown>;
  exampleFile: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<WizardResult> {
  const rl = createInterface({ input: opts.input ?? process.stdin, output: opts.output ?? process.stdout });
  const { ask } = createAsker(rl);
  try {
    console.log("欢迎使用 Nyra！三步就能跑起第一个任务。");
    console.log("（全程不注册、不登录；模型只用你自己的 Key，本地任务不花钱。）");
    console.log("");

    // 第 1 步：选模型来源
    console.log("第 1 步：选模型来源");
    const order = providerOrder(opts.config);
    order.forEach((name, i) => {
      const p: ProviderPreset | undefined = lookupPreset(opts.config, name);
      const tag = name === "ollama" ? "（本地模型，不用 Key）"
        : name === "codex" ? "（复用本机 Codex 登录，不用 Key）"
        : name === "custom" ? "（自己配 endpoint）"
        : !p ? "（自定义 provider）"
        : `（默认模型 ${p.defaultModel}）`;
      console.log(`  ${i + 1}）${name} ${tag}`);
    });
    const defIdx = order.indexOf(opts.provider.name);
    const choice = await ask(`输入编号（默认 ${defIdx >= 0 ? defIdx + 1 : "（当前 " + opts.provider.name + "）"}，${opts.provider.name}）：`);
    let providerName = opts.provider.name;
    if (choice) {
      const n = Number(choice);
      if (Number.isInteger(n) && n >= 1 && n <= order.length) providerName = order[n - 1];
      else if (lookupPreset(opts.config, choice)) providerName = choice;
      else console.log(`看不懂“${choice}”，用默认的 ${providerName}。`);
    }
    const preset = lookupPreset(opts.config, providerName) ?? { baseUrl: null, defaultModel: null, envKey: "NYRA_API_KEY", connector: null, allowedHosts: [], models: [] };
    let model = preset.defaultModel || "";
    if (preset.models.length > 1) {
      const m = await ask(`模型（${preset.models.join(" / ")}，默认 ${model}）：`);
      if (m) model = m;
    } else if (preset.defaultModel === null) {
      model = await ask("模型名（custom provider 需要手动填）：");
    }
    console.log(`已选：${providerName} / ${model}`);
    console.log("");

    // 第 2 步：填 Key 或选本地
    console.log("第 2 步：配置 Key");
    let keyConfigured = false;
    if (providerName === "ollama" || providerName === "codex") {
      console.log(providerName === "ollama"
        ? "Ollama 是本地模型，不用 Key。请确认本机装好并启动了 Ollama（默认 http://localhost:11434）。"
        : "Codex 复用本机 Codex CLI 的登录态，不用 Key。请确认已在本机运行 codex 登录。");
      keyConfigured = true;
    } else if (preset.envKey && process.env[preset.envKey]) {
      console.log(`检测到环境变量 ${preset.envKey} 已有 Key，不用再填。`);
      keyConfigured = true;
    } else if (preset.envKey) {
      console.log("注意：输入的 Key 会在终端上明文显示（输完请清屏，不要截图分享）。");
      const key = await ask(`输入 ${preset.envKey}（直接回车跳过，稍后再设）：`);
      if (key) {
        const rc = detectShellRc();
        const answer = await ask(`要把 export ${preset.envKey}=... 追加进 ${rc} 吗？（以后打开终端自动生效；输入 y 才追加，默认不追加）：`);
        if (/^(y|yes|是)$/i.test(answer)) {
          if (rc) appendFileSync(rc, `\n# Nyra（nyra setup 写入）\nexport ${preset.envKey}=${key}\n`, "utf-8");
          console.log(`已追加进 ${rc}。重新打开终端后生效；本次请先跑：export ${preset.envKey}=你的Key`);
          keyConfigured = false; // 本进程环境变量还没变，实话实说
        } else {
          console.log(`没写进任何文件。请自己跑：export ${preset.envKey}=你的Key（只对当前终端生效）`);
          keyConfigured = false;
        }
      } else {
        console.log("跳过了 Key 设置。没有 Key 也能先跑本地示例任务，模型任务等设好 Key 再跑。");
      }
    }
    // 只保存 provider / model 到 config.json，Key 绝不落盘。
    saveConfig(opts.home, { provider: providerName, model });
    console.log(`配置已保存到 ${join(opts.home, "config.json")}（只含 provider / model，不含 Key）。`);
    console.log("");

    // 第 3 步：跑一条本地示例任务
    console.log("第 3 步：跑一条示例任务（本地任务，不调模型、不花钱）");
    let exampleOk = false;
    try {
      const result = runExampleTask({ home: opts.home, provider: providerName, model, file: opts.exampleFile });
      exampleOk = result.rows === 100;
    } catch (err) {
      console.log(`示例任务没跑起来：${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("");
    if (exampleOk) {
      console.log("向导完成！第一个任务已经跑通。");
      console.log("下一步：有 Key 就跑模型任务（Node 版 agent 核心在第 2 阶段，现在请用 python3 -m nyra）；");
      console.log("没 Key 就先跑 nyra doctor 看看缺什么，或跑 nyra --example 再练一次。");
    } else {
      console.log("示例任务没跑通，按上面的报错处理，或跑 nyra doctor 自检。");
    }
    return { provider: providerName, model, keyConfigured, exampleOk };
  } finally {
    rl.close();
  }
}

/** 向导的默认示例文件：优先读本机真实存在的文件，不存在就用 config.json 自己。 */
export function defaultExampleFile(home: string): string {
  const candidates = [join(home, "config.json"), "README.md", "GUIDE.md"];
  for (const c of candidates) {
    try {
      if (existsSync(c) && readFileSync(c, "utf-8").length > 0) return c;
    } catch { /* 继续找下一个 */ }
  }
  return join(home, "config.json");
}
