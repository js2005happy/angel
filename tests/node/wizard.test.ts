// tests/node/wizard.test.ts — 向导的提问队列（管道输入不丢行）与 Key 绝不落盘。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { createAsker, runWizard, detectShellRc } from "../../src/wizard.ts";
import { loadConfig, resolveProvider } from "../../src/config.ts";

test("createAsker：管道式一次性到齐的行不丢，按序回答", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output });
  const { ask } = createAsker(rl);
  input.write("first\nsecond\nthird\n");
  input.end();
  expect(await ask("q1: ")).toBe("first");
  expect(await ask("q2: ")).toBe("second");
  expect(await ask("q3: ")).toBe("third");
  expect(await ask("q4: ")).toBe(""); // EOF 后当作空回答，不挂住
  rl.close();
});

test("向导无 Key 全默认：三步跑通，config 只有 provider/model，没有 Key", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-wizard-test-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const config = loadConfig(home);
  const provider = resolveProvider({ home, config });
  const file = join(home, "sample.txt");
  writeFileSync(file, "hello wizard", "utf-8");
  const run = runWizard({ home, provider, config, exampleFile: file, input, output });
  input.write("\n\n\n");
  input.end();
  const result = await run;
  expect(result.provider).toBe("deepseek");
  expect(result.model).toBe("deepseek-flash");
  expect(result.exampleOk).toBe(true);
  expect(result.keyConfigured).toBe(false);
  const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf-8"));
  expect(saved.provider).toBe("deepseek");
  expect(JSON.stringify(saved)).not.toMatch("sk-");
});

test("向导填 Key 后拒绝写 rc：Key 不进 config.json，也不进 shell rc", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-wizard-key-test-"));
  const rc = join(home, ".bashrc");
  writeFileSync(rc, "", "utf-8");
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const config = loadConfig(home);
    const provider = resolveProvider({ home, config });
    const file = join(home, "sample.txt");
    writeFileSync(file, "hello", "utf-8");
    const run = runWizard({ home, provider, config, exampleFile: file, input, output });
    input.write("3\n\nsk-test-fake-key-999\nn\n");
    input.end();
    const result = await run;
    expect(result.exampleOk).toBe(true);
    expect(readFileSync(join(home, "config.json"), "utf-8")).not.toMatch("sk-test-fake-key-999");
    expect(readFileSync(rc, "utf-8")).not.toMatch("sk-test-fake-key-999");
  } finally {
    process.env.HOME = origHome;
  }
});

test("向导用自定义 provider：全默认不崩，示例任务跑通", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-wizard-custom-test-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const config = loadConfig(home);
  config.custom_providers = {
    myllm: { base_url: "http://127.0.0.1:8080/v1", default_model: "my-model", env_key: "MYLLM_API_KEY", models: ["my-model"] },
  };
  config.provider = "myllm";
  config.model = "my-model";
  delete process.env.MYLLM_API_KEY;
  const provider = resolveProvider({ home, config });
  const file = join(home, "sample.txt");
  writeFileSync(file, "hello custom", "utf-8");
  const run = runWizard({ home, provider, config, exampleFile: file, input, output });
  input.write("\n\n\n");
  input.end();
  const result = await run;
  expect(result.provider).toBe("myllm");
  expect(result.model).toBe("my-model");
  expect(result.exampleOk).toBe(true);
});

test("detectShellRc：SHELL=zsh 时优先 .zshrc", () => {
  const origShell = process.env.SHELL;
  const origHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "nyra-rc-test-"));
  process.env.HOME = home;
  process.env.SHELL = "/bin/zsh";
  try {
    expect(detectShellRc()).toBe(join(home, ".zshrc"));
  } finally {
    process.env.SHELL = origShell;
    process.env.HOME = origHome;
  }
});
