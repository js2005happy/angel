// src/net.ts — 网络小工具，与 Python 版 nyra/net.py 同语义。
export function isLoopbackHost(host: string): boolean {
  const h = (host || "").trim().toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h.endsWith(".localhost")) return true;
  return false;
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 明文 http 只允许本机主机名（与 config.plaintextHttpError 同一条线）。 */
export function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL 无效：${url}`);
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`明文 http:// 只允许本机地址：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`只支持 http(s) URL：${url}`);
  }
}
