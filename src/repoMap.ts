// src/repoMap.ts — 轻量 Repo Map（缺口 24 第一批）。
//
// 目标：给规划阶段的强推理模型一份"代码地图"——每个文件只抽函数/类签名，
// 不喂正文，让模型一眼看清项目结构、定位要改的文件，而不是靠瞎猜或整仓
// 扫描。这是省 token 的核心：一次规划要把整段上下文喂给强推理模型，正文
// 体积远大于签名，只留签名能把成本压到 ~1k token 以内。
//
// 设计纪律（与 Python 版对齐"不引重依赖、宁可少报不可错报"）：
//   - **不引 tree-sitter**：用语言感知的正则启发式抽签名。签名拿不准就跳过，
//     绝不做半截签名（宁可漏，不可错）。
//   - **默认 ~1000 token 预算**：按 4 字符 ≈ 1 token 的粗口径估算（与
//     agent.ts 的 estimated 口径一致），超了就按优先级裁剪（先砍注释，再砍
//     低信号文件的签名，最后截断单文件）。
//   - **纯函数 + 只读**：不 spawn、不联网、不改状态；文件系统访问由调用方
//     决定（可传入自定义 readFile，便于测试与后端隔离）。
//   - **尊重 .gitignore 级跳过**：node_modules/.git/构建产物等恒跳过。

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 恒跳过的目录（无论语言）。 */
export const REPO_MAP_SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".cache",
  "__pycache__", ".venv", "venv", ".idea", ".vscode", ".nyra", "coverage",
  "target", ".gradle", "vendor", "bower_components",
]);

/** 参与 repo map 的文件扩展名（按语言分组）。 */
export const REPO_MAP_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php",
]);

/** 单文件最大读取字节（超了只读前 N 字节，避免把大文件整个读进内存）。 */
export const REPO_MAP_MAX_FILE_BYTES = 256 * 1024;

/** 默认 token 预算（按 4 字符 ≈ 1 token 估算，约 4000 字符）。 */
export const REPO_MAP_DEFAULT_TOKEN_BUDGET = 1000;

/** 单文件最多保留的签名行数（签名太多时截断，避免单个大文件吃掉整个预算）。 */
export const REPO_MAP_MAX_SIGS_PER_FILE = 60;

const CHARS_PER_TOKEN = 4;

export interface RepoMapOptions {
  /** 工作目录（repo 根）。 */
  workdir: string;
  /** token 预算（默认 1000）。 */
  tokenBudget?: number;
  /** 额外要包含的目录（如 --add-dir），默认空。 */
  extraDirs?: string[];
  /** 是否包含文件头部的包/导入级注释（低信号，默认关）。 */
  includeComments?: boolean;
  /** 注入只读文件（测试/后端隔离用）；回调收到的是相对工作目录的路径（正斜杠）；不传走 node:fs。 */
  readFile?: (relPath: string) => string | null;
  /** 只列出这些文件（不递归扫描）；用于"只 map 特定文件"。路径相对工作目录（正斜杠）。 */
  files?: string[];
}

export interface RepoMapResult {
  /** 拼好的 repo map 文本（Markdown）。 */
  text: string;
  /** 估算 token 数（4 字符 ≈ 1 token）。 */
  estimatedTokens: number;
  /** 参与的文件数。 */
  fileCount: number;
  /** 抽到的签名总数。 */
  sigCount: number;
  /** 是否因预算被截断。 */
  truncated: boolean;
}

/**
 * 抽一个文件里的函数/类/接口/类型签名（语言感知的正则启发式）。
 * 返回形如 `func name(params)` / `class Name` 的签名行；拿不准的跳过。
 */
export function extractSignatures(source: string, ext: string): string[] {
  const lines = source.split("\n");
  const out: string[] = [];
  // 去掉行内注释，避免把注释当成签名的一部分；保留行首缩进以判断层级。
  const stripComment = (l: string): string => {
    // 简单处理：去掉 // 之后的内容（不处理字符串里的 //，签名场景足够）。
    const i = l.indexOf("//");
    return i >= 0 ? l.slice(0, i) : l;
  };

  const isTsLike = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
  const isPython = ext === ".py";
  const isGoRust = [".go", ".rs"].includes(ext);
  const isJavaLike = [".java", ".kt", ".kts", ".cs"].includes(ext);

  if (isTsLike) return extractTsSignatures(source, stripComment);
  if (isPython) return extractPythonSignatures(source);
  if (isGoRust) return extractGoRustSignatures(source);
  if (isJavaLike) return extractJavaLikeSignatures(source);
  // C/C++/Ruby/PHP：退化为通用启发式（函数名 + 参数括号）。
  return extractGenericSignatures(source, stripComment);
}

function extractTsSignatures(source: string, stripComment: (l: string) => string): string[] {
  const out: string[] = [];
  const re = /^\s*(export\s+)?(default\s+)?(async\s+)?(function\s+)?([A-Za-z_$][\w$]*)\s*(<[^>]*>)?\s*\(([^)]*)\)\s*(:\s*[^{=]+)?\s*[{=]/;
  const classRe = /^\s*(export\s+)?(abstract\s+)?(class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
  const arrowRe = /^\s*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(<[^>]*>)?\s*=\s*(async\s*)?\(([^)]*)\)\s*=>/;
  for (const raw of source.split("\n")) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    let m = classRe.exec(raw);
    if (m) { out.push(`${m[1] ? "export " : ""}${m[2] ? "abstract " : ""}${m[3]} ${m[4]}`); continue; }
    m = arrowRe.exec(raw);
    if (m) { out.push(`${m[1] ? "export " : ""}${m[3]}(${m[6]})`); continue; }
    m = re.exec(raw);
    if (m) {
      const name = m[5];
      // 过滤控制流关键字（if/for/while/switch/catch 的括号误匹配）。
      if (["if", "for", "while", "switch", "catch", "with"].includes(name)) continue;
      out.push(`${m[1] ? "export " : ""}${m[3] ? "async " : ""}${name}(${m[7].trim()})`);
    }
  }
  return out;
}

function extractPythonSignatures(source: string): string[] {
  const out: string[] = [];
  const fnRe = /^\s*(async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;
  const clsRe = /^\s*class\s+([A-Za-z_]\w*)/;
  for (const raw of source.split("\n")) {
    let m = clsRe.exec(raw);
    if (m) { out.push(`class ${m[1]}`); continue; }
    m = fnRe.exec(raw);
    if (m) out.push(`${m[1] ? "async " : ""}def ${m[2]}(${m[3].trim()})`);
  }
  return out;
}

function extractGoRustSignatures(source: string): string[] {
  const out: string[] = [];
  // Go: func (recv) Name(args)  /  func Name(args)
  const goFnRe = /^\s*func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/;
  // Rust: fn name(args) / pub fn name(args)
  const rustFnRe = /^\s*(pub\s+)?(async\s+)?fn\s+([A-Za-z_]\w*)\s*(<[^>]*>)?\s*\(([^)]*)\)/;
  const typeRe = /^\s*(pub\s+)?(type|struct|enum|trait|interface)\s+([A-Za-z_]\w*)/;
  for (const raw of source.split("\n")) {
    let m = typeRe.exec(raw);
    if (m) { out.push(`${m[1] ? "pub " : ""}${m[2]} ${m[3]}`); continue; }
    m = rustFnRe.exec(raw);
    if (m) { out.push(`${m[1] ? "pub " : ""}${m[2] ? "async " : ""}fn ${m[3]}(${m[5].trim()})`); continue; }
    m = goFnRe.exec(raw);
    if (m) out.push(`func ${m[2]}(${m[3].trim()})`);
  }
  return out;
}

function extractJavaLikeSignatures(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*(public|private|protected|internal|static|final|abstract|@\w+[\s\S]*?)*\s*(?:[\w<>\[\],\s]+\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{?/;
  const clsRe = /^\s*(public\s+|private\s+)?(class|interface|enum|record)\s+([A-Za-z_]\w*)/;
  for (const raw of source.split("\n")) {
    const m = clsRe.exec(raw);
    if (m) { out.push(`${m[1] ?? ""}${m[2]} ${m[3]}`); continue; }
    const fm = re.exec(raw);
    if (fm && fm[2]) {
      const name = fm[2];
      if (["if", "for", "while", "switch", "catch", "return", "new", "synchronized"].includes(name)) continue;
      out.push(`${name}(${fm[3].trim()})`);
    }
  }
  return out;
}

function extractGenericSignatures(source: string, stripComment: (l: string) => string): string[] {
  const out: string[] = [];
  const fnRe = /^\s*([\w:]+\s+)?([*&]?\w+)\s*\(([^;{]*)\)\s*[{=]/;
  for (const raw of source.split("\n")) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const m = fnRe.exec(raw);
    if (m && m[2]) {
      const name = m[2].replace(/^[*&]/, "");
      if (["if", "for", "while", "switch", "return"].includes(name)) continue;
      out.push(`${name}(${m[3].trim()})`);
    }
  }
  return out;
}

/** 判断一个路径是否应参与 repo map（按扩展名 + 跳过目录）。 */
export function isRepoMapCandidate(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => REPO_MAP_SKIP_DIRS.has(p))) return false;
  const dot = rel.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = rel.slice(dot).toLowerCase();
  return REPO_MAP_EXTENSIONS.has(ext);
}

/**
 * 递归列出 repo 下参与 map 的文件（相对路径）。跳过隐藏目录与跳过目录。
 * 尊重文件数量上限，避免超大仓库把内存/预算撑爆。
 */
export function listRepoMapFiles(workdir: string, extraDirs: string[] = []): string[] {
  const out: string[] = [];
  const roots = [workdir, ...extraDirs.filter((d) => d && d !== workdir)];
  const seen = new Set<string>();
  const walk = (dir: string, base: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return; // 无权限/不存在：跳过
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue; // 隐藏文件/目录
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (REPO_MAP_SKIP_DIRS.has(entry)) continue;
        walk(full, base);
      } else {
        const rel = relative(base, full).split(sep).join("/");
        if (!isRepoMapCandidate(rel)) continue;
        if (seen.has(rel)) continue;
        seen.add(rel);
        out.push(rel);
      }
    }
  };
  for (const root of roots) {
    if (!existsSync(root)) continue;
    walk(root, workdir);
  }
  return out.sort();
}

/** 估算文本的 token 数（4 字符 ≈ 1 token，与 agent.ts 的 estimated 口径一致）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * 生成 repo map 文本。核心：每个文件一个 `### 路径` 头 + 若干签名行，
 * 预算内按文件优先级（有签名的文件优先、签名多的文件优先）保留。
 */
export function buildRepoMap(opts: RepoMapOptions): RepoMapResult {
  const workdir = opts.workdir;
  const budget = opts.tokenBudget ?? REPO_MAP_DEFAULT_TOKEN_BUDGET;
  const read = opts.readFile ?? ((relPath: string) => {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      return fs.readFileSync(join(workdir, relPath), "utf-8");
    } catch {
      return null;
    }
  });

  const files = (opts.files ?? listRepoMapFiles(workdir, opts.extraDirs ?? []))
    .map((r) => r.split("\\").join("/"));
  const perFile: { rel: string; sigs: string[] }[] = [];

  for (const rel of files) {
    const dot = rel.lastIndexOf(".");
    const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : "";
    const raw = read(rel);
    if (raw == null) continue;
    const sigs = extractSignatures(raw.slice(0, REPO_MAP_MAX_FILE_BYTES), ext)
      .slice(0, REPO_MAP_MAX_SIGS_PER_FILE);
    if (sigs.length) perFile.push({ rel, sigs });
  }

  // 按签名数降序：签名多的文件信号更强，优先保留。
  perFile.sort((a, b) => b.sigs.length - a.sigs.length || a.rel.localeCompare(b.rel));

  // 预算裁剪：逐文件累加，超预算就停。
  const budgetChars = budget * CHARS_PER_TOKEN;
  const sections: string[] = [];
  let used = 0;
  let truncated = false;
  let sigCount = 0;
  const included: typeof perFile = [];

  for (const f of perFile) {
    const block = `### ${f.rel}\n${f.sigs.join("\n")}\n`;
    const cost = block.length;
    if (used + cost > budgetChars && sections.length > 0) {
      truncated = true;
      break;
    }
    sections.push(block);
    used += cost;
    sigCount += f.sigs.length;
    included.push(f);
  }

  // 一个文件都放不下（极窄预算）：至少保留第一个文件的头部签名。
  if (!sections.length && perFile.length) {
    const f = perFile[0];
    const head = `### ${f.rel}\n${f.sigs.slice(0, Math.max(1, Math.floor(budgetChars / 8))).join("\n")}\n`;
    sections.push(head);
    sigCount += f.sigs.length;
    truncated = true;
  }

  const body = sections.join("\n");
  const text = body.length
    ? `# Repo Map（函数/类签名，约 ${budget} token 预算）\n\n${body}`
    : "";
  return {
    text,
    estimatedTokens: estimateTokens(text),
    fileCount: included.length,
    sigCount,
    truncated,
  };
}
