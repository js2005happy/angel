// src/pyjson.ts — Python json.dumps 默认格式的复刻（供字节对等用）。
// Python json.dump(obj) 默认 separators=(', ', ': ')，ensure_ascii=False 时
// 非 ASCII 直接写 UTF-8；indent=2 时分隔符为 (',', ': ')。
// Node 的 JSON.stringify 用的是紧凑分隔符，state.json / sessions.jsonl
// 与 Python 版逐字节对比时会差空格，故这里单独实现。
export function pythonJsonDump(value: unknown, indent?: number): string {
  if (indent === undefined) return dumpValue(value, 0, undefined);
  return dumpValue(value, 0, indent);
}

function escapeString(s: string, ensureAscii: boolean): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else if (ensureAscii && code > 0x7f) {
      if (code > 0xffff) {
        const v = code - 0x10000;
        out += "\\u" + (0xd800 + (v >> 10)).toString(16).padStart(4, "0");
        out += "\\u" + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
      } else {
        out += "\\u" + code.toString(16).padStart(4, "0");
      }
    } else out += ch;
  }
  return out + '"';
}

function dumpValue(value: unknown, depth: number, indent: number | undefined, ensureAscii = false): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON 无法序列化非有限数字");
    return String(value);
  }
  if (typeof value === "string") return escapeString(value, ensureAscii);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (indent === undefined) {
      return "[" + value.map((v) => dumpValue(v, depth + 1, indent, ensureAscii)).join(", ") + "]";
    }
    const pad = " ".repeat(indent * (depth + 1));
    const closePad = " ".repeat(indent * depth);
    return "[\n" + value.map((v) => pad + dumpValue(v, depth + 1, indent, ensureAscii)).join(",\n") + "\n" + closePad + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    if (indent === undefined) {
      return "{" + entries.map(([k, v]) => `${escapeString(k, ensureAscii)}: ${dumpValue(v, depth + 1, indent, ensureAscii)}`).join(", ") + "}";
    }
    const pad = " ".repeat(indent * (depth + 1));
    const closePad = " ".repeat(indent * depth);
    return "{\n" + entries.map(([k, v]) => `${pad}${escapeString(k, ensureAscii)}: ${dumpValue(v, depth + 1, indent, ensureAscii)}`).join(",\n") + "\n" + closePad + "}";
  }
  throw new Error(`JSON 无法序列化：${typeof value}`);
}

/** Python json.dump(..., indent=2, sort_keys=True) 的等价输出（vault.json 用）。 */
export function pythonJsonDumpSorted(value: unknown, indent = 2): string {
  const sorted = sortDeep(value);
  return dumpValue(sorted, 0, indent, true);
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
