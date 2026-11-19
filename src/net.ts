// src/net.ts — 网络小工具，与 Python 版 nyra/net.py 同语义。
import { lookup } from "node:dns/promises";

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

// -- SSRF 拦截（审查报告第 5 项）：只拦内网/保留地址段，公网 URL 正常放行。
// 取 URL 是常用功能，全拦等于把功能砍掉；拦内网段挡住的是“用 Nyra 当跳板
// 去摸内网服务 / 云厂商元数据接口”那一类。重定向的每一跳也要过同一道检查。
// 诚实边界：这拦的是“地址本身在内网段”，拦不住内网服务自己暴露到公网、
// 也拦不住 DNS 解析后地址被换掉（TOCTOU）；本地开发可用 NYRA_ALLOW_PRIVATE_URLS=1 放行。
const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8 本网络
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10 CGNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 回环
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24 TEST-NET-1
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 基准测试
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 0xefffffff], // 224.0.0.0/4 组播
  [0xf0000000, 0xffffffff], // 240.0.0.0/4 保留
];

function parseIpv4(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map((p) => Number(p));
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const h = (ip || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4 映射的 IPv6 地址（::ffff:10.0.0.1）：解包后按 IPv4 判断。
  // 注意 URL 解析器会把 ::ffff:10.0.0.1 规范化成 ::ffff:a00:1（十六进制两段），两种写法都要认。
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) return isPrivateOrReservedIp(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const v4 = ((hi << 16) | lo) >>> 0;
    return PRIVATE_IPV4_RANGES.some(([loRange, hiRange]) => v4 >= loRange && v4 <= hiRange);
  }
  const v4 = parseIpv4(h);
  if (v4 !== null) {
    return PRIVATE_IPV4_RANGES.some(([lo, hi]) => v4 >= lo && v4 <= hi);
  }
  if (h === "::" || h === "::1") return true; // 未指定 / 回环
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 链路本地
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 唯一本地
  if (/^ff[0-9a-f]{2}:/.test(h)) return true; // ff00::/8 组播
  if (/^2001:0?db8:/.test(h)) return true; // 2001:db8::/32 文档地址
  return false;
}

export function isPrivateOrReservedHost(host: string): boolean {
  const h = (host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  if (h === "localhost" || h === "metadata.google.internal" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (parseIpv4(h) !== null) return isPrivateOrReservedIp(h);
  if (h.includes(":")) return isPrivateOrReservedIp(h); // IPv6 字面量
  return false;
}

/** 工具取 URL 前调用：内网/保留地址段直接拦，公网放行。DNS 解析失败时放行，交给 fetch 自己报错。 */
export async function assertPublicUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL 无效：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`只支持 http(s) URL：${url}`);
  }
  if (process.env.NYRA_ALLOW_PRIVATE_URLS === "1") return; // 本地开发放行
  const host = parsed.hostname;
  if (isPrivateOrReservedHost(host)) {
    throw new Error(`已拦截内网/保留地址：${url}（本地开发可设 NYRA_ALLOW_PRIVATE_URLS=1 放行）`);
  }
  // 域名要看解析结果：域名本身看不出内网，解析出的 IP 在内网段才拦。
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    for (const a of addrs) {
      if (isPrivateOrReservedIp(a.address)) {
        throw new Error(`已拦截内网/保留地址：${url}（${host} 解析到 ${a.address}；本地开发可设 NYRA_ALLOW_PRIVATE_URLS=1 放行）`);
      }
    }
  } catch (err) {
    if (err instanceof Error && /已拦截内网/.test(err.message)) throw err;
    // 解析失败（域名不存在等）不拦，交给 fetch 自己报错。
  }
}

