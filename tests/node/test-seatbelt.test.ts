// tests/node/test-seatbelt.test.ts — P0-6：macOS Seatbelt profile 生成。
// profile 生成是纯函数，可在任何平台单测；真正的 sandbox-exec 执行只在 macOS 上跑，
// 这里只断言"策略写成什么样"，不 spawn。
import { test, expect } from "bun:test";
import { buildSeatbeltProfile, seatbeltBinary, seatbeltAvailable, describeSeatbelt } from "../../src/seatbelt.ts";

const WD = "/Users/dev/project";

test("默认拒绝：profile 以 deny default 开头", () => {
  const p = buildSeatbeltProfile({ mode: "workspace-write", workdir: WD, allowNet: false });
  expect(p.startsWith("(version 1)")).toBe(true);
  expect(p).toContain("(deny default)");
  // deny default 必须在任何 allow 之前
  expect(p.indexOf("(deny default)")).toBeLessThan(p.indexOf("(allow "));
});

test("workspace-write：只给工作目录与临时目录写权限", () => {
  const p = buildSeatbeltProfile({ mode: "workspace-write", workdir: WD, allowNet: false });
  expect(p).toContain(`(allow file-write* (subpath "${WD}"))`);
  expect(p).toContain('(subpath "/private/tmp")');
  expect(p).toContain('(subpath "/private/var/folders")');
  // 不应出现"给根目录写"
  expect(p).not.toContain('(subpath "/")');
});

test("read-only：不给 file-write*，只留设备节点", () => {
  const p = buildSeatbeltProfile({ mode: "read-only", workdir: WD, allowNet: false });
  expect(p).not.toContain("(allow file-write*");
  expect(p).toContain('(literal "/dev/null")');
});

test("网络：默认只放本地回环，allowNet 后放开", () => {
  const closed = buildSeatbeltProfile({ mode: "workspace-write", workdir: WD, allowNet: false });
  expect(closed).not.toContain("(allow network*)");
  expect(closed).toContain('"localhost:*"');

  const open = buildSeatbeltProfile({ mode: "workspace-write", workdir: WD, allowNet: true });
  expect(open).toContain("(allow network*)");
});

test("danger-full-access：与 bwrap 语义一致（allow default）", () => {
  const p = buildSeatbeltProfile({ mode: "danger-full-access", workdir: WD, allowNet: false });
  expect(p).toContain("(allow default)");
  expect(p).not.toContain("(deny default)");
});

test("extraWritable 会追加可写路径", () => {
  const p = buildSeatbeltProfile({
    mode: "workspace-write", workdir: WD, allowNet: false, extraWritable: ["/Users/dev/.nyra"],
  });
  expect(p).toContain('(allow file-write* (subpath "/Users/dev/.nyra"))');
});

test("路径里的双引号与反斜杠被转义（不能靠路径注入 profile）", () => {
  const nasty = '/tmp/ev"il\\path';
  const p = buildSeatbeltProfile({ mode: "workspace-write", workdir: nasty, allowNet: false });
  expect(p).toContain('(subpath "/tmp/ev\\"il\\\\path")');
});

test("非 macOS 平台：seatbelt 不可用（不假装能用）", () => {
  if (process.platform === "darwin") {
    expect(typeof seatbeltBinary()).toBe("string");
  } else {
    expect(seatbeltBinary()).toBeNull();
    expect(seatbeltAvailable()).toBe(false);
  }
});

test("describeSeatbelt 给出可读摘要", () => {
  const s = describeSeatbelt({ mode: "workspace-write", workdir: WD, allowNet: false });
  expect(s).toContain("Seatbelt");
  expect(s).toContain("workspace-write");
  expect(s).toContain("本地回环");
});
