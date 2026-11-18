// src/citations.ts — 引用台账（方案 2.6 第 1 条，Hermes grounded-citations）。
// 编号与 URL 由记录产生，不由记忆产生；模型只输出小整数编号；
// 每条来源附逐字引用，脚本校验字面出现，否则拒绝；
// 模型记忆内容一律标 [unverified]；无证据整份草稿不合格。
export interface CitationSource {
  id: number;
  url: string;
  title?: string;
  quote: string;
}

export class CitationLedger {
  private sources: CitationSource[] = [];
  private byUrl = new Map<string, number>();

  /** 登记一条来源，返回编号（同一 URL 复用同一编号）。 */
  register(url: string, quote: string, title?: string): number {
    const existing = this.byUrl.get(url);
    if (existing !== undefined) return existing;
    const id = this.sources.length + 1;
    this.sources.push({ id, url, title, quote });
    this.byUrl.set(url, id);
    return id;
  }

  get(id: number): CitationSource | undefined {
    return this.sources.find((s) => s.id === id);
  }

  list(): CitationSource[] {
    return [...this.sources];
  }

  /** 校验：草稿里每个 [n] 引用都必须有登记来源，且来源的逐字引用必须在证据文本里字面出现。 */
  verify(draft: string, evidenceText: string): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const refs = [...draft.matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1], 10));
    for (const ref of new Set(refs)) {
      const src = this.get(ref);
      if (!src) {
        problems.push(`引用 [${ref}] 没有登记的来源`);
        continue;
      }
      if (src.quote && !evidenceText.includes(src.quote)) {
        problems.push(`来源 [${ref}] 的逐字引用未在证据文本里字面出现`);
      }
    }
    return { ok: problems.length === 0, problems };
  }

  /** 记忆内容（非检索证据）一律标 [unverified]，不得当作已核实引用。 */
  static markUnverified(text: string): string {
    return `${text} [unverified]`;
  }

  renderBibliography(): string {
    return this.sources
      .map((s) => `[${s.id}] ${s.title ? s.title + " — " : ""}${s.url}`)
      .join("\n");
  }
}
