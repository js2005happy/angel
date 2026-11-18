// src/evidence.ts — 证据文件存储，与 Python 版 nyra/evidence.py 同语义。
// 文件名带序号（001_kind_slug.md），不覆盖；头部含来源/抓取时间/类型；正文最多 20000 字。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_EVIDENCE_CHARS = 20000;

function slugify(url: string): string {
  const after = url.split("://", 2)[1] ?? url;
  const slug = after.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "");
  return slug || "page";
}

export class EvidenceStore {
  readonly dir: string;
  private index = 0;

  constructor(baseDir: string, sessionId: string) {
    this.dir = join(baseDir, sessionId);
    mkdirSync(this.dir, { recursive: true });
    for (const file of readdirSync(this.dir).filter((f) => f.endsWith(".md"))) {
      const m = /^(\d+)_/.exec(file);
      if (m) this.index = Math.max(this.index, parseInt(m[1], 10));
    }
  }

  save(kind: string, url: string, content: string, query?: string | null): string {
    const slug = slugify(url);
    const safeKind = kind.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
    let path: string;
    for (;;) {
      this.index += 1;
      const name = `${String(this.index).padStart(3, "0")}_${safeKind}_${slug}.md`;
      path = join(this.dir, name);
      if (!existsSync(path)) break;
    }
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    let header =
      `# 证据 ${this.index}\n\n` +
      `- 来源：${url}\n` +
      `- 抓取时间：${stamp}\n` +
      `- 类型：${kind}\n`;
    if (query) header += `- 搜索词：${query}\n`;
    writeFileSync(path, header + "\n" + content.slice(0, MAX_EVIDENCE_CHARS), { encoding: "utf-8", flag: "wx" });
    return path;
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".md")).sort().map((f) => join(this.dir, f));
  }

  read(name: string): string | null {
    const path = join(this.dir, name.replace(/[^A-Za-z0-9_.-]/g, "_"));
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  }
}
