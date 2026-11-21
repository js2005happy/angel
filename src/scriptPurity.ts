// src/scriptPurity.ts — Pi Bot 借鉴第 1 条：脚本内容判定（纯度判定）。
//
// 只借设计，不照抄 Pi Bot 的代码与 API 形状：
//   - 白名单静态分析，判不明白的一律算“不纯”（宁可多问一次，不放过一次）；
//   - Python / JavaScript / Lua / PHP 四种语言，代码超过 64 KB 直接判不纯；
//   - Ruby / Perl / PowerShell 靠名字调方法，白名单证不出来，直接判不纯。
// 纯的脚本在工作流例行里按只读命令处理（不用每次都问）；判定结果写进
// 证据链（script_pure 事件：哪门语言、哪个摘要、纯还是不纯、为什么）。
//
// 诚实边界：这只是静态白名单，不是沙箱。它拦得住“看得懂的危险构造”，
// 拦不住存心绕过的人（比如把危险调用拆开再拼起来——拼接本身就判不纯，
// 但再精巧的混淆仍可能漏网）。真正的高危操作靠审批流程 + 摘要预授权
//（内容一改摘要就失效）+ 用户自己看一眼命令原文，不要以为判了纯就安全。
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, resolve, sep } from "node:path";

export type ScriptLanguage = "python" | "javascript" | "lua" | "php";
export const SCRIPT_PURE_CODE_MAX = 64 * 1024;
export const SCRIPT_LANGUAGES: readonly ScriptLanguage[] = ["python", "javascript", "lua", "php"];

export interface PurityVerdict {
  pure: boolean;
  language: ScriptLanguage;
  /** 判定理由（短句，不含路径与代码原文，只进证据链与审计）。 */
  reason: string;
}

/** 摘要：代码正文的 SHA-256（hex）。`script:<摘要>` 是预授权的范围 id。 */
export function scriptDigest(code: string): string {
  return createHash("sha256").update(code, "utf-8").digest("hex");
}

export function scriptScopeId(digest: string): string {
  return `script:${digest}`;
}

function impure(language: ScriptLanguage, reason: string): PurityVerdict {
  return { pure: false, language, reason };
}

function pure(language: ScriptLanguage): PurityVerdict {
  return { pure: true, language, reason: "白名单静态分析通过" };
}

/** 语言名不在四种里（Ruby / Perl / PowerShell 等）一律判不纯。 */
export function judgeScript(language: string, code: string): PurityVerdict {
  if (language === "python") return judgePython(code);
  if (language === "javascript") return judgeJavaScript(code);
  if (language === "lua") return judgeLua(code);
  if (language === "php") return judgePhp(code);
  return { pure: false, language: "python", reason: `不支持的语言：${language}` };
}

// ---------------------------------------------------------------------------------------------
// Python。白名单模块 + 受限的 sys 成员；危险的裸词（open/eval/exec…）
// 与双下划线属性一律不纯；import 只认独占一行的写法，别处出现 import
// 一律不纯；NFKC 折叠后也要过一遍（全角字符折叠后可能变成危险名字）。
const PYTHON_PURE_MODULES = new Set([
  "json", "sys", "re", "math", "datetime", "collections", "itertools",
  "functools", "statistics", "decimal", "fractions", "textwrap", "typing",
  "dataclasses", "enum", "time", "hashlib", "base64", "bisect", "heapq",
]);
// sys 里纯脚本用得到的成员；sys.modules / _getframe / exc_info 会通向别的代码。
const PYTHON_SYS = new Set([
  "stdin", "stdout", "stderr", "argv", "exit", "maxsize", "version",
  "version_info", "platform", "byteorder", "float_info",
  "getrecursionlimit", "setrecursionlimit",
]);
const PYTHON_DANGEROUS_WORDS =
  /\b(?:open|eval|exec|compile|getattr|setattr|delattr|globals|locals|vars|input|breakpoint|help|memoryview|get_type_hints|ForwardRef|singledispatch|singledispatchmethod|evaluate_forward_ref)\b/u;
/** zip 包的结束记录：`python3 文件` 跑的是 zip 里的 __main__.py，不是读到的字节。 */
export const PYTHON_ZIP_END = "PK\u0005\u0006";

/**
 * PEP 263 声明在前两行会让 Python 按声明的编码解码文件（utf-7 会把 +…-
 * 变成新的源码行），所以只认 UTF-8 与 ASCII——它们读出来就是判定看到的样子。
 */
export function pythonOtherCoding(code: string): boolean {
  for (const line of code.replace(/^\uFEFF/u, "").split(/\r\n|\r|\n/u, 3)) {
    const name = /coding[:=][ \t]*([-\w.]+)/u.exec(line)?.[1];
    if (name && !/^(?:utf-?8|ascii|us-ascii)$/u.test(name.toLowerCase().replaceAll("_", "-"))) return true;
  }
  return false;
}

function judgePython(code: string): PurityVerdict {
  if (code.length > SCRIPT_PURE_CODE_MAX) return impure("python", "代码超过 64 KB");
  if (code.includes(PYTHON_ZIP_END)) return impure("python", "zip 包直接当脚本跑");
  if (pythonOtherCoding(code)) return impure("python", "声明了非 UTF-8 编码");
  const r = judgePythonText(code);
  if (!r.pure) return r;
  // Python 会按 NFKC 折叠标识符（全角字符折叠后可能变成 exec），折叠后的文本也要过一遍。
  const folded = code.normalize("NFKC");
  if (folded !== code) {
    const r2 = judgePythonText(folded);
    if (!r2.pure) return impure("python", "NFKC 折叠后出现危险构造");
  }
  return pure("python");
}

const PYTHON_IMPORT_LINE =
  /^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import[ \t]+(\(?[\w, \t*]+\)?)|import[ \t]+([\w., \t]+))[ \t]*(?:#[^\n]*)?$/gmu;

function judgePythonText(code: string): PurityVerdict {
  // 内置函数一直都在作用域里，所以能开文件、求值、按名取属性的裸词也要拦
  //（`f = open` 和 `open(` 一样危险）。帧与代码对象（gi_frame.f_builtins）
  // 会通向全部内置函数；get_type_hints 与 singledispatch 会求值字符串注解。
  if (PYTHON_DANGEROUS_WORDS.test(code)) return impure("python", "出现危险内置调用");
  if (/__\w+__/u.test(code.replace(/__name__\s*==\s*["']__main__["']/gu, ""))) {
    return impure("python", "出现双下划线属性");
  }
  if (/\.(?:f|gi|cr|ag|tb|co)_\w+/u.test(code)) return impure("python", "出现帧或代码对象属性");
  // import 只按独占一行的写法算；写在别处（分号后、字符串里、多行形式）
  // 的 import 没被证明，一律判不纯。
  let imports = 0;
  let body = code;
  for (const match of code.matchAll(PYTHON_IMPORT_LINE)) {
    imports++;
    body = body.replace(match[0], "");
    const from = match[1];
    const names = (from ? [from] : (match[3] ?? "").split(",")).map(
      (part) => part.trim().split(/\s+as\s+/u)[0]?.split(".")[0] ?? "",
    );
    if (names.some((name) => !PYTHON_PURE_MODULES.has(name))) {
      return impure("python", "导入了白名单外的模块");
    }
    // `import sys as s` / `from sys import modules` 会绕过下面的成员检查。
    if (/\bsys\b/u.test(match[3] ?? "") && /\bas\b/u.test(match[3] ?? "")) {
      return impure("python", "sys 用了别名");
    }
    if (
      from === "sys" &&
      (match[2] ?? "")
        .replace(/[()]/gu, "")
        .split(",")
        .some((name) => !PYTHON_SYS.has(name.trim().split(/\s+as\s+/u)[0] ?? ""))
    ) {
      return impure("python", "从 sys 导入了白名单外的成员");
    }
  }
  if ((code.match(/\bimport\b/gu) ?? []).length !== imports) {
    return impure("python", "import 不在行首");
  }
  for (const match of body.matchAll(/\bsys\b(\s*\.\s*(\w+))?/gu)) {
    if (!PYTHON_SYS.has(match[2] ?? "")) return impure("python", "用了 sys 白名单外的成员");
  }
  return pure("python");
}

// ---------------------------------------------------------------------------------------------
// JavaScript (Node)。`node -e` 把每个内置模块都暴露成全局变量（fs、
// child_process），所以边界是：根名字必须在 JS_ALLOWED 里，或者必须是
// Node 自己不定义的名字（脚本自己的绑定或 ReferenceError，永远到不了
// 能力）。能通向构造器、原型、帧或内部状态的成员一律不认；算出来的
// 访问（x[k]）只认字面量 key，因为算出来的 key 可以拼出任意成员。
const JS_ALLOWED = new Set([
  "console", "JSON", "Math", "Number", "String", "Array", "Object", "Date",
  "RegExp", "Map", "Set", "WeakMap", "WeakSet", "Boolean", "BigInt", "Symbol",
  "Promise", "Error", "TypeError", "RangeError", "SyntaxError", "URIError",
  "AggregateError", "Intl", "Infinity", "NaN", "undefined", "parseInt",
  "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "Buffer", "TextEncoder", "TextDecoder", "URL",
  "URLSearchParams", "structuredClone", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "setImmediate", "clearImmediate",
  "queueMicrotask", "atob", "btoa", "ArrayBuffer", "DataView", "Uint8Array",
  "Uint8ClampedArray", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array",
  "Int32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
]);
const JS_PROCESS = new Set(["stdin", "stdout", "stderr", "argv", "exit", "exitCode"]);
const JS_FORBIDDEN_WORDS = new Set(["this", "with", "arguments", "import", "export", "eval"]);
const JS_FORBIDDEN_MEMBERS = new Set([
  "constructor", "prototype", "caller", "callee", "arguments",
  "getPrototypeOf", "setPrototypeOf", "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors", "getOwnPropertyNames", "getOwnPropertySymbols",
  "defineProperty", "defineProperties", "prepareStackTrace", "captureStackTrace",
  "mainModule", "binding",
]);
// 这些保留字后面 `/` 开正则、`[` 开数组，不是除法或成员；of、yield、await
// 在松散脚本里也是普通名字，它们后面的 `/` 含义不明，直接判不纯。
const JS_EXPRESSION_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "new", "delete", "void", "throw",
  "case", "do", "else", "const", "var",
]);
const JS_CONTEXTUAL_WORDS = new Set(["of", "yield", "await"]);
const JS_NUMBER = /^(?:0[xXoObB][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)n?/u;
const JS_LINE_END = /[\n\r]/u;

interface JsSkeleton {
  /** 注释已清、每个字面量都换成了 `"<序号>"` 或 `0` 后的代码。 */
  text: string;
  strings: string[];
}

/**
 * 把注释与字面量抹掉，只剩代码骨架。以下情况直接返回 undefined（骨架
 * 与引擎实际执行的不一致）：字面量外的反斜杠或非 ASCII 字符（名字里的
 * Unicode 转义）、`#`（私有名字）、没闭合的字面量、`/` 的含义要看前一
 * 个 token 之外的上下文。
 */
function jsSkeleton(code: string): JsSkeleton | undefined {
  // HTML 式注释（<!--、-->）与 U+2028/9 行尾会改变注释在哪结束。
  if (/<!--|-->|[\u2028\u2029]/u.test(code)) return undefined;
  const strings: string[] = [];
  const out: string[] = [];
  const braces: ("{" | "${")[] = [];
  const parenOwners: string[] = [];
  let i = code.startsWith("#!") ? code.indexOf("\n") + 1 || code.length : 0;
  let prev: "start" | "punct" | "word" | "value" | "close-paren" | "close-brace" = "start";
  let prevWord = "";
  let prevMember = false;
  let prevPunct = "";
  let closedOwner = "";
  const literal = (text: string) => {
    strings.push(text);
    out.push(` "${strings.length - 1}" `);
    prev = "value";
  };
  // 从 i 开始扫模板文本，直到闭合反引号或下一个 ${。
  const template = (): boolean => {
    while (i < code.length) {
      const c = code[i] as string;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        out.push(" 0 ");
        prev = "value";
        return true;
      }
      if (c === "$" && code[i + 1] === "{") {
        i += 2;
        braces.push("${");
        out.push(" ( ");
        prev = "punct";
        prevPunct = "(";
        return true;
      }
      i++;
    }
    return false;
  };
  while (i < code.length) {
    const c = code[i] as string;
    if (/\s/u.test(c)) {
      out.push(c === "\n" ? "\n" : " ");
      i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && !JS_LINE_END.test(code[i] as string)) i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      i = end + 2;
      out.push(" ");
      continue;
    }
    if (c === "'" || c === '"') {
      let text = "";
      i++;
      for (;;) {
        const d = code[i];
        if (d === undefined || JS_LINE_END.test(d)) return undefined;
        i++;
        if (d === c) break;
        if (d === "\\") {
          text += code[i] ?? "";
          i++;
          continue;
        }
        text += d;
      }
      literal(text);
      continue;
    }
    if (c === "`") {
      i++;
      if (!template()) return undefined;
      continue;
    }
    if (c === "/") {
      const word = prev === "word" && !prevMember;
      const regex =
        prev === "start" ||
        prev === "punct" ||
        (word && JS_EXPRESSION_AFTER_WORD.has(prevWord)) ||
        (prev === "close-paren" && ["if", "while", "for", "with"].includes(closedOwner));
      // `a++ / b`、` } /x/`、`of / x` 怎么读，要看骨架看不到的上下文，直接判不纯。
      if (
        prev === "close-brace" ||
        (prev === "punct" && ["++", "--"].includes(prevPunct)) ||
        (word && JS_CONTEXTUAL_WORDS.has(prevWord))
      ) {
        return undefined;
      }
      if (regex) {
        let inClass = false;
        i++;
        for (;;) {
          const d = code[i];
          if (d === undefined || JS_LINE_END.test(d)) return undefined;
          i++;
          if (d === "\\") {
            i++;
            continue;
          }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
        }
        while (/[a-z]/u.test(code[i] ?? "")) i++;
        out.push(" 0 ");
        prev = "value";
        continue;
      }
    }
    if (c === "\\" || c === "#" || c.charCodeAt(0) > 0x7e) return undefined;
    const word = /^[A-Za-z_$][\w$]*/u.exec(code.slice(i, i + 256))?.[0];
    if (word) {
      out.push(word);
      i += word.length;
      prevMember = prev === "punct" && prevPunct === ".";
      prev = "word";
      prevWord = word;
      continue;
    }
    const number = JS_NUMBER.exec(code.slice(i, i + 256))?.[0];
    if (number) {
      out.push(" 0 ");
      i += number.length;
      prev = "value";
      continue;
    }
    if (c === "{") braces.push("{");
    if (c === "}") {
      const top = braces.pop();
      if (top === "${") {
        out.push(" ) ");
        i++;
        if (!template()) return undefined;
        continue;
      }
      out.push("}");
      i++;
      prev = "close-brace";
      continue;
    }
    if (c === "(") parenOwners.push(prev === "word" && !prevMember ? prevWord : "");
    if (c === ")") {
      closedOwner = parenOwners.pop() ?? "";
      out.push(")");
      i++;
      prev = "close-paren";
      continue;
    }
    if (c === "]") {
      out.push("]");
      i++;
      prev = "value";
      continue;
    }
    const pair = code.slice(i, i + 2);
    prevPunct = pair === "++" || pair === "--" ? pair : c;
    out.push(prevPunct);
    i += prevPunct.length;
    prev = "punct";
  }
  return braces.length ? undefined : { text: out.join(""), strings };
}

const jsBefore = (text: string, index: number) => {
  let j = index - 1;
  while (j >= 0 && /\s/u.test(text[j] as string)) j--;
  return { char: text[j] ?? "", index: j };
};
const jsAfter = (text: string, index: number) => {
  let j = index;
  while (j < text.length && /\s/u.test(text[j] as string)) j++;
  return { char: text[j] ?? "", index: j };
};
const jsWordBefore = (text: string, index: number) =>
  /([A-Za-z_$][\w$]*)$/u.exec(text.slice(Math.max(0, index - 64), index + 1))?.[1];

function judgeJavaScript(code: string): PurityVerdict {
  if (code.length > SCRIPT_PURE_CODE_MAX) return impure("javascript", "代码超过 64 KB");
  const skeleton = jsSkeleton(code);
  if (!skeleton) return impure("javascript", "骨架扫不明白（歧义的斜杠、未闭合的字面量或模板）");
  const { text, strings } = skeleton;
  // Node 自己定义的根名字（本运行时的全局变量 + 内置模块 + 别的版本或
  // 运行时会定义的包装绑定）：在里面的名字不是白名单就是能力，脚本自己
  // 的绑定不在里面，永远到不了能力。
  const jsKnown = new Set([
    ...Object.getOwnPropertyNames(globalThis),
    // Node 自己定义的根名字还包括全部内置模块（去掉 node: 前缀与子路径）。
    ...builtinModules.map((name) => name.replace(/^node:/u, "").split("/")[0] ?? name),
    "require", "module", "exports", "__filename", "__dirname", "global",
    "globalThis", "process", "fetch", "WebSocket", "EventSource", "navigator",
    "Navigator", "localStorage", "sessionStorage", "Storage", "Worker",
    "SharedWorker", "XMLHttpRequest", "importScripts", "eval", "Function",
    "Reflect", "Proxy", "WebAssembly", "Atomics", "SharedArrayBuffer",
    "FinalizationRegistry", "WeakRef", "Deno", "Bun", "sqlite", "test",
    "sea", "this", "arguments",
  ]);
  const forbiddenMember = (name: string) => name.startsWith("_") || JS_FORBIDDEN_MEMBERS.has(name);
  // `.name` 与 `?.name` 是成员；`...name` 展开的是根值。
  const memberAt = (index: number) => {
    const previous = jsBefore(text, index);
    return previous.char === "." && text[previous.index - 1] !== ".";
  };
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const name = match[0];
    const start = match.index;
    const end = start + name.length;
    if (JS_FORBIDDEN_WORDS.has(name)) return impure("javascript", `出现禁用的词：${name}`);
    if (memberAt(start)) {
      if (forbiddenMember(name)) return impure("javascript", `出现禁用的成员：${name}`);
      continue;
    }
    const previous = jsBefore(text, start);
    const next = jsAfter(text, end);
    // `{ key: …}` / `, key: …` 是属性名，不是绑定。
    if ((previous.char === "{" || previous.char === ",") && next.char === ":") continue;
    if (name === "process") {
      const member = /^\s*\.\s*([A-Za-z_$][\w$]*)/u.exec(text.slice(end, end + 64))?.[1];
      if (!member || !JS_PROCESS.has(member)) return impure("javascript", "用了 process 白名单外的成员");
      continue;
    }
    if (jsKnown.has(name) && !JS_ALLOWED.has(name)) {
      return impure("javascript", `用了白名单外的全局名字：${name}`);
    }
  }
  for (const match of text.matchAll(/\[/gu)) {
    const previous = jsBefore(text, match.index);
    const word = jsWordBefore(text, previous.index);
    const expressionWord =
      !!word && JS_EXPRESSION_AFTER_WORD.has(word) && !memberAt(previous.index - word.length + 1);
    const access =
      [")", "]", "}", '"', "."].includes(previous.char) ||
      (/[\w$]/u.test(previous.char) && !expressionWord);
    if (!access) continue;
    const key = /^\[\s*(?:0|"(\d+)")\s*\]/u.exec(text.slice(match.index, match.index + 32));
    if (!key) return impure("javascript", "算出来的成员访问");
    const literal = key[1] === undefined ? undefined : strings[Number(key[1])];
    if (literal !== undefined && (forbiddenMember(literal) || literal === "process")) {
      return impure("javascript", `算出来的成员名是禁用的：${literal}`);
    }
  }
  return pure("javascript");
}

// ---------------------------------------------------------------------------------------------
// Lua。标准解释器的全局变量是公开的封闭集合（5.1–5.4 与 LuaJIT）；
// 集合外的根名字是脚本自己的变量或 nil。io 与 os 只放行 stdio 与时钟成员。
const LUA_GLOBALS = new Set(
  (
    "_G _VERSION _ENV arg assert bit bit32 collectgarbage coroutine debug dofile error ffi gcinfo " +
    "getfenv getmetatable io ipairs jit load loadfile loadstring math module newproxy next os " +
    "package pairs pcall print rawequal rawget rawlen rawset require select setfenv setmetatable " +
    "string table tonumber tostring type unpack utf8 warn xpcall"
  ).split(" "),
);
const LUA_ALLOWED = new Set(
  (
    "_VERSION arg assert bit32 coroutine error getmetatable ipairs math next pairs pcall print " +
    "rawequal rawget rawlen rawset select setmetatable string table tonumber tostring type unpack " +
    "utf8 xpcall"
  ).split(" "),
);
const LUA_LIMITED: Record<string, ReadonlySet<string>> = {
  io: new Set(["write", "read", "stdout", "stderr", "stdin"]),
  os: new Set(["time", "clock", "date", "difftime", "exit"]),
};
const LUA_KEYWORDS = new Set(
  (
    "and break do else elseif end false for function goto if in local nil not or repeat return " +
    "then true until while"
  ).split(" "),
);

function luaSkeleton(code: string): string | undefined {
  const out: string[] = [];
  let i = code.startsWith("#") ? code.indexOf("\n") + 1 || code.length : 0;
  const longBracket = (at: number) => /^\[(=*)\[/u.exec(code.slice(at, at + 64))?.[1];
  while (i < code.length) {
    const c = code[i] as string;
    if (c === "-" && code[i + 1] === "-") {
      const level = longBracket(i + 2);
      if (level !== undefined) {
        const end = code.indexOf(`]${level}]`, i + 4 + level.length);
        if (end < 0) return undefined;
        i = end + level.length + 2;
      } else while (i < code.length && !/[\n\r]/u.test(code[i] as string)) i++;
      out.push(" ");
      continue;
    }
    if (c === "[") {
      const level = longBracket(i);
      if (level !== undefined) {
        const end = code.indexOf(`]${level}]`, i + 2 + level.length);
        if (end < 0) return undefined;
        i = end + level.length + 2;
        out.push(' "" ');
        continue;
      }
    }
    if (c === "'" || c === '"') {
      i++;
      for (;;) {
        const d = code[i];
        if (d === undefined || d === "\n" || d === "\r") return undefined;
        i++;
        if (d === c) break;
        if (d === "\\") i++;
      }
      out.push(' "" ');
      continue;
    }
    if (c === "\\" || c.charCodeAt(0) > 0x7e) return undefined;
    out.push(c);
    i++;
  }
  return out.join("");
}

function judgeLua(code: string): PurityVerdict {
  if (code.length > SCRIPT_PURE_CODE_MAX) return impure("lua", "代码超过 64 KB");
  const text = luaSkeleton(code);
  if (text === undefined) return impure("lua", "骨架扫不明白（未闭合的字符串或长注释）");
  for (const match of text.matchAll(/[A-Za-z_]\w*/gu)) {
    const name = match[0];
    const start = match.index;
    const end = start + name.length;
    if (/\d/u.test(text[start - 1] ?? "")) continue; // 数字的一部分，如 0x1f 或 1e5
    if (LUA_KEYWORDS.has(name)) continue;
    const previous = jsBefore(text, start);
    const next = jsAfter(text, end);
    const prior = text[previous.index - 1];
    // `t.name` / `t:name()` 是成员；`a..b` 是连接，`::label::` 是标签。
    if ((previous.char === "." && prior !== ".") || (previous.char === ":" && prior !== ":")) continue;
    if (previous.char === ":" && prior === ":") continue;
    if (jsWordBefore(text, previous.index) === "goto") continue;
    // `{ key = …}` / `, key = …` 是字段名（或赋值目标），不是读。
    if (
      (previous.char === "{" || previous.char === "," || previous.char === ";") &&
      next.char === "=" &&
      text[next.index + 1] !== "="
    ) {
      continue;
    }
    const limited = LUA_LIMITED[name];
    if (limited) {
      const member = /^\s*\.\s*([A-Za-z_]\w*)/u.exec(text.slice(end, end + 64))?.[1];
      if (!member || !limited.has(member)) return impure("lua", `用了 ${name} 白名单外的成员`);
      continue;
    }
    if (LUA_GLOBALS.has(name) && !LUA_ALLOWED.has(name)) {
      return impure("lua", `用了白名单外的全局名字：${name}`);
    }
  }
  return pure("lua");
}

// ---------------------------------------------------------------------------------------------
// PHP。每一次按名调用必须是白名单里的内置函数（不带回调——回调可以是
// 写着任意函数名的字符串）、语言结构，或文件顶层声明的函数（顶层声明
// 与内置函数重名是编译错误，所以它永远代替不了内置函数）。动态调用、
// new、静态调用、include 与超全局变量一律不认。
const PHP_FUNCTIONS = new Set(
  (
    "abs array_chunk array_column array_combine array_count_values array_fill array_flip " +
    "array_key_exists array_key_first array_key_last array_keys array_merge array_pad array_pop " +
    "array_product array_push array_reverse array_search array_shift array_slice array_sum " +
    "array_unique array_unshift array_values arsort asort base64_decode base64_encode bin2hex " +
    "bindec boolval ceil checkdate chr count crc32 date decbin dechex explode feof fgets " +
    "floatval floor fmod fputs fread fwrite gettype hash hex2bin hexdec htmlspecialchars " +
    "implode in_array intdiv intval is_array is_bool is_float is_int is_null is_numeric " +
    "is_string join krsort ksort lcfirst levenshtein ltrim max mb_strlen mb_strtolower " +
    "mb_strtoupper mb_substr md5 microtime min mktime mt_rand nl2br number_format ord pow " +
    "preg_match preg_match_all preg_quote preg_split print_r printf rand random_int range round " +
    "rsort rtrim sha1 similar_text sizeof sort sprintf sqrt str_contains str_ends_with str_pad " +
    "str_repeat str_split str_starts_with str_word_count stream_get_contents strlen strpos " +
    "strrev strrpos strtolower strtoupper strval substr time trim ucfirst ucwords var_dump " +
    "var_export wordwrap stripos str_replace str_ireplace json_encode json_decode"
  ).split(" "),
);
const PHP_CONSTRUCTS = new Set(
  (
    "if elseif while for foreach switch match catch array list isset empty unset function fn " +
    "return echo print exit die and or xor declare use static"
  ).split(" "),
);
const PHP_FORBIDDEN_WORDS = new Set(
  (
    "include include_once require require_once eval new clone class interface trait enum " +
    "namespace goto extends implements insteadof abstract final __halt_compiler"
  ).split(" "),
);

function phpSkeleton(raw: string): string | undefined {
  let code = raw.startsWith("#!") ? raw.slice(raw.indexOf("\n") + 1 || raw.length) : raw;
  code = code.replace(/^\s*<\?php\b/u, "").replace(/\?>\s*$/u, "");
  // `?>` 会结束 PHP 模式，哪怕它在 `//` 注释里；后面的文本可能重新打开 PHP。
  if (/<\?|\?>|<<<|`|#\[/u.test(code)) return undefined;
  const out: string[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i] as string;
    if ((c === "/" && code[i + 1] === "/") || c === "#") {
      while (i < code.length && !/[\n\r]/u.test(code[i] as string)) i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      i = end + 2;
      out.push(" ");
      continue;
    }
    if (c === "'" || c === '"') {
      let text = "";
      i++;
      for (;;) {
        const d = code[i];
        if (d === undefined) return undefined;
        i++;
        if (d === c) break;
        if (d === "\\") {
          text += code[i] ?? "";
          i++;
          continue;
        }
        text += d;
      }
      // 双引号里的插值表达式（`{$a->b()}`、`${…}`）会在字符串里跑代码。
      if (c === '"' && /\{\$|\$\{/u.test(text)) return undefined;
      out.push(" '' ");
      continue;
    }
    if (c === "\\" || c.charCodeAt(0) > 0x7e) return undefined;
    out.push(c);
    i++;
  }
  return out.join("");
}

function judgePhp(code: string): PurityVerdict {
  if (code.length > SCRIPT_PURE_CODE_MAX) return impure("php", "代码超过 64 KB");
  const text = phpSkeleton(code);
  if (text === undefined) return impure("php", "骨架扫不明白（未闭合的字符串、注释或插值）");
  // 经由值调用（`$f()`、`'system'()`、`$a['f']()`、`(…)()`）、静态调用、
  // 可变变量与动态属性名。
  if (/::|\$\$|\$\{|->\s*\$|\$\w*\s*\(|['\])}]\s*\(/u.test(text)) {
    return impure("php", "出现动态调用或静态调用");
  }
  if (/\$(?:_\w*|GLOBALS)\b/u.test(text)) return impure("php", "出现超全局变量");
  const declared = new Set<string>();
  let depth = 0;
  const depthAt: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    depthAt[i] = depth;
  }
  for (const match of text.matchAll(/\bfunction\s*&?\s*([A-Za-z_]\w*)\s*\(/giu)) {
    // 只有无条件的顶层声明在编译期就是确定的（见文件头注释）。
    if ((depthAt[match.index] ?? 0) !== 0) return impure("php", "函数声明不在顶层");
    declared.add((match[1] as string).toLowerCase());
  }
  for (const match of text.matchAll(/[A-Za-z_]\w*/gu)) {
    const name = match[0].toLowerCase();
    const start = match.index;
    const end = start + name.length;
    if (/[\w$]/u.test(text[start - 1] ?? "")) continue; // 变量（$x）或数字的一部分
    if (PHP_FORBIDDEN_WORDS.has(name)) return impure("php", `出现禁用的词：${name}`);
    const previous = jsBefore(text, start);
    if (previous.char === ">" && text[previous.index - 1] === "-") continue; // ->方法 / ->属性
    if (jsWordBefore(text, previous.index)?.toLowerCase() === "function") continue;
    const next = jsAfter(text, end);
    if (name === "use" && !(next.char === "(" && previous.char === ")")) {
      return impure("php", "use 不是闭包的 use");
    }
    if (next.char !== "(") continue; // 常量、关键字或命名参数
    if (!PHP_FUNCTIONS.has(name) && !PHP_CONSTRUCTS.has(name) && !declared.has(name)) {
      return impure("php", `调用了白名单外的函数：${name}`);
    }
  }
  return pure("php");
}

// ---------------------------------------------------------------------------------------------
// Shell 命令 → 脚本调用。只有“恰好一条解释器跑一个脚本”才认：
// 解释器名、允许的 flag、脚本文件或内联代码、其余都是 argv。
// 别的写法（管道、拼接、重定向、通配符、看不懂的 flag）一律返回 null，
// 调用方按老路子走（该问的还是问），不把解析失败当成纯脚本放行。
export interface ParsedScriptRun {
  language: ScriptLanguage;
  /** 内联代码（-c/-e/-r），或脚本文件正文。 */
  code: string;
  /** 文件脚本时的文件绝对路径（内联时 null）。 */
  file: string | null;
  /** 传给脚本的参数（argv，不参与纯度判定：纯脚本拿参数也碰不到文件/进程/网络）。 */
  args: string[];
}

const INTERPRETERS: Record<string, ScriptLanguage> = {
  python: "python",
  python3: "python",
  node: "javascript",
  lua: "lua",
  "lua5.4": "lua",
  "lua5.3": "lua",
  "lua5.1": "lua",
  luajit: "lua",
  php: "php",
};
const INLINE_FLAGS: Record<ScriptLanguage, string[]> = {
  python: ["-c"],
  javascript: ["-e"],
  lua: ["-e"],
  php: ["-r"],
};
const PLAIN_FLAGS: Record<ScriptLanguage, string[]> = {
  python: ["-u", "-I"],
  javascript: [],
  lua: [],
  php: [],
};

/**
 * 分词：引号与反斜杠转义照 shell 的规矩；引号外的 shell 元字符
 *（; & | < > ( )、换行）或 `$`、反引号、通配符（* ?）出现即返回 null——
 * 那不是一条单纯的脚本调用。返回的 token 仍带引号，由 unquoteShellToken 脱引号。
 */
function tokenizeShell(command: string): string[] | null {
  const tokenRe = /(?:[^\s;&|<>()"'\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+|[;&|<>()]/g;
  const rawTokens = command.match(tokenRe) ?? [];
  const tokens: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && (ch === "\n" || ch === "\r")) return null;
  }
  // 引号没闭合：分词正则会静默丢掉落单的引号，不能继续解析。
  if (inSingle || inDouble) return null;
  for (const t of rawTokens) {
    if ([";", "&", "|", "<", ">", "(", ")"].includes(t)) return null;
    tokens.push(t);
  }
  return tokens;
}

/** 脱一层 shell 引号：单引号里是原文；双引号里只认 \" \\ \$ \` 与换行续行。 */
function unquoteShellToken(token: string): string | null {
  if (token.length >= 2 && token[0] === "'" && token[token.length - 1] === "'") {
    return token.slice(1, -1);
  }
  if (token.length >= 2 && token[0] === '"' && token[token.length - 1] === '"') {
    const inner = token.slice(1, -1);
    let out = "";
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i] as string;
      if (c === "\\" && i + 1 < inner.length) {
        const next = inner[i + 1] as string;
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          out += next;
          i++;
          continue;
        }
        if (next === "\n") {
          i++;
          continue;
        }
      }
      out += c;
    }
    return out;
  }
  // 没加引号的 token：$、反引号、通配符一律不认（展开后的东西判定看不见）。
  if (/[$`*\?]/u.test(token)) return null;
  return token;
}

export function parseShellScript(command: string, cwd: string, workdir: string): ParsedScriptRun | null {
  const tokens = tokenizeShell(command);
  if (!tokens || tokens.length === 0) return null;
  const interp = basename(tokens[0] as string);
  const language = INTERPRETERS[interp];
  if (!language) return null;
  let i = 1;
  // 只认白名单里的 flag；别的 flag（比如 --input-type）一律不认。
  let inline = false;
  while (i < tokens.length && (tokens[i] as string).startsWith("-") && tokens[i] !== "-") {
    const flag = tokens[i] as string;
    if (INLINE_FLAGS[language].includes(flag)) {
      inline = true;
      i++;
      break;
    }
    if (PLAIN_FLAGS[language].includes(flag)) {
      i++;
      continue;
    }
    return null;
  }
  const rest = tokens.slice(i).map((t) => unquoteShellToken(t));
  if (rest.some((t) => t === null)) return null;
  const parts = rest as string[];
  if (inline) {
    if (parts.length === 0) return null;
    return { language, code: parts[0] as string, file: null, args: parts.slice(1) };
  }
  if (parts.length === 0) return null;
  const fileArg = parts[0] as string;
  if (fileArg.startsWith("-")) return null;
  const resolved = resolve(cwd, fileArg);
  // 文件必须在工作目录内。realpath 只用于越界比较，不改写返回值——
  // 与缺口 25 修补第二轮的 realpath 教训同口径：下游按字符串比路径，
  // 返回值保持词法拼写。
  let real: string;
  let realWorkdir: string;
  try {
    if (!existsSync(resolved)) return null;
    real = realpathSync(resolved);
    realWorkdir = realpathSync(workdir);
  } catch {
    return null;
  }
  if (real !== realWorkdir && !real.startsWith(realWorkdir + sep)) return null;
  let code: string;
  try {
    code = readFileSync(real, "utf-8");
  } catch {
    return null;
  }
  return { language, code, file: resolved, args: parts.slice(1) };
}
