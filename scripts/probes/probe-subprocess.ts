// Bun API 兼容性探针 3：子进程 spawn / execFile —— 退出码、stdout/stderr 分离、超时杀进程。
// 影响：tools.py 的 shell 工具、providers.py 的 Codex CLI 子进程、MCP stdio 启动。
import { spawn, execFile } from "node:child_process";

const out = await new Promise<string>((resolve, reject) => {
  execFile(process.execPath, ["-e", "console.log('hello-stdout'); console.error('hello-stderr')"],
    (err, stdout, stderr) => {
      if (err) return reject(err);
      if (stdout.trim() !== "hello-stdout" || stderr.trim() !== "hello-stderr") {
        return reject(new Error(`stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
      }
      resolve(stdout.trim());
    });
});

const killed = await new Promise<boolean>((resolve) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"]);
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(true); }, 500);
  child.on("exit", () => { clearTimeout(timer); resolve(true); });
  setTimeout(() => resolve(false), 5000);
});
if (!killed) throw new Error("超时杀进程失败");

const code = await new Promise<number>((resolve) => {
  const child = spawn(process.execPath, ["-e", "process.exit(3)"]);
  child.on("exit", (c) => resolve(c ?? -1));
});
if (code !== 3) throw new Error("退出码应为 3，实为 " + code);

console.log(`PASS subprocess: execFile stdout/stderr 分离 OK（${out}）、超时 SIGKILL OK、退出码 3 OK`);
process.exit(0);
