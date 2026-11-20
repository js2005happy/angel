// src/office.ts — 缺口 23：成品级办公套件直出可编辑真文件（T6）。
//
// Genspark AI Slides/Sheets/Docs 与 Manus 的核心卖点是“交成品”：直出可继续
// 编辑的真 PPTX/XLSX/DOCX，而不是一段文字。Nyra 的做法：三个确定性写出器
// （纯 TS 手写最小 OOXML，不引重型原生依赖、不引 zip 库），产出的文件用
// Office/WPS 打开能直接编辑；附事实核查（每个数字须有来源，见
// verifyOfficeDocument，与证据链同口径）——别家的成品只管“能打开”，
// Nyra 管“打开了能验证”。
//
// 设计要点：
//   - zip 用最简单的 stored（不压缩）写出：条目原样存放，文件仍是合法 zip，
//     Office 能正常打开；不引 jszip/fflate 等依赖（仓库此前零 zip 依赖）。
//   - 内容模型只接受结构化输入（标题/段落/列表/表格/数值），模型不直接拼 XML；
//     写出前先跑事实核查，无来源的数字按配置标“未核实”（默认标，不拒绝）。
//   - 事件与日志只记元数据与指纹，不记文件全文、绝对路径与图片内容。
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { loadConfig } from "./config.ts";

/** 缺口 23：办公导出的配置（config.json 的 office 一节，未配用默认值）。 */
export interface OfficeConfig {
  /** 单个导出文件上限（字节），默认 10MB；超了拒绝写出。 */
  maxBytes: number;
  /** 无来源的数字是否在正文里标“未核实”，默认 true；关了也仍进核查小节与事件。 */
  markUnverified: boolean;
}

export const DEFAULT_OFFICE_CONFIG: OfficeConfig = {
  maxBytes: 10 * 1024 * 1024,
  markUnverified: true,
};

/** 非法值回退默认值（与 vision/voice 同款：不抛错、不静默改写配置）。 */
export function resolveOfficeConfig(config: Record<string, unknown> | null | undefined): OfficeConfig {
  const raw = (config?.office ?? {}) as Record<string, unknown>;
  const maxBytes = typeof raw.max_bytes === "number" && Number.isFinite(raw.max_bytes) && raw.max_bytes > 0
    ? Math.floor(raw.max_bytes) : DEFAULT_OFFICE_CONFIG.maxBytes;
  const markUnverified = typeof raw.mark_unverified === "boolean" ? raw.mark_unverified : true;
  return { maxBytes, markUnverified };
}

// ---- 内容模型 ----

/** 一个事实的来源标注：证据编号、文件名或链接（写进核查，不进文件正文）。 */
export type OfficeSource = string;

/** 表格/数值单元格。value 是数字时按 format 格式化；formula 是 Excel 公式。 */
export interface OfficeCell {
  value: string | number;
  /** 数字/断言的来源；没给 = 未核实。 */
  source?: OfficeSource;
  /** 数值格式：默认按值自动（数字 = 常规）；currency/percent/date 强制格式。 */
  format?: "text" | "number" | "currency" | "percent" | "date";
  /** Excel 公式（如 SUM(B2:B3)）；给了就按公式写出，value 当缓存值。 */
  formula?: string;
}

export interface OfficeTable {
  headers: OfficeCell[];
  rows: OfficeCell[][];
}

export type OfficeBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string; source?: OfficeSource }
  | { kind: "paragraph"; text: string; source?: OfficeSource }
  | { kind: "bullets"; items: { text: string; source?: OfficeSource }[] }
  | { kind: "table"; table: OfficeTable }
  | { kind: "image"; image: string; caption?: string; source?: OfficeSource };

export interface OfficeSheet {
  name: string;
  headers: OfficeCell[];
  rows: OfficeCell[][];
}

export interface OfficeImage {
  /** 图片名（PPTX 里 ppt/media/<name>）；须与 image 块的 image 字段对应。 */
  name: string;
  /** 图片字节的 base64（只认 PNG/JPEG，按文件头校验，不看扩展名）。 */
  data: string;
}

export type OfficeFormat = "docx" | "xlsx" | "pptx";

export interface OfficeDocument {
  title: string;
  format: OfficeFormat;
  /** DOCX/PPTX 用的内容块；XLSX 忽略 blocks、只用 sheets。 */
  blocks?: OfficeBlock[];
  /** XLSX 用的表；DOCX/PPTX 忽略 sheets。 */
  sheets?: OfficeSheet[];
  /** PPTX 图片块用的图片；DOCX/XLSX 忽略。 */
  images?: OfficeImage[];
}

// ---- 结构校验（未知输入 → 结构化文档，形状不对直接报错） ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asCell(v: unknown, where: string): OfficeCell {
  if (!isRecord(v)) throw new Error(`内容结构无效：${where} 应为对象`);
  if (typeof v.value !== "string" && typeof v.value !== "number") {
    throw new Error(`内容结构无效：${where}.value 应为字符串或数字`);
  }
  if (v.source !== undefined && typeof v.source !== "string") throw new Error(`内容结构无效：${where}.source 应为字符串`);
  if (v.format !== undefined && !["text", "number", "currency", "percent", "date"].includes(String(v.format))) {
    throw new Error(`内容结构无效：${where}.format 只支持 text/number/currency/percent/date`);
  }
  if (v.formula !== undefined && typeof v.formula !== "string") throw new Error(`内容结构无效：${where}.formula 应为字符串`);
  const cell: OfficeCell = { value: v.value };
  if (typeof v.source === "string") cell.source = v.source;
  if (typeof v.format === "string") cell.format = v.format as OfficeCell["format"];
  if (typeof v.formula === "string") cell.formula = v.formula;
  return cell;
}

function asTable(v: unknown, where: string): OfficeTable {
  if (!isRecord(v) || !Array.isArray(v.headers) || !Array.isArray(v.rows)) {
    throw new Error(`内容结构无效：${where} 应含 headers/rows 数组`);
  }
  return {
    headers: v.headers.map((c, i) => asCell(c, `${where}.headers[${i}]`)),
    rows: v.rows.map((r, i) => {
      if (!Array.isArray(r)) throw new Error(`内容结构无效：${where}.rows[${i}] 应为数组`);
      return r.map((c, j) => asCell(c, `${where}.rows[${i}][${j}]`));
    }),
  };
}

function asBlock(v: unknown, where: string): OfficeBlock {
  if (!isRecord(v) || typeof v.kind !== "string") throw new Error(`内容结构无效：${where}.kind 缺失`);
  if (v.kind === "heading") {
    if (v.level !== 1 && v.level !== 2 && v.level !== 3) throw new Error(`内容结构无效：${where}.level 只支持 1/2/3`);
    if (typeof v.text !== "string") throw new Error(`内容结构无效：${where}.text 应为字符串`);
    const b: OfficeBlock = { kind: "heading", level: v.level, text: v.text };
    if (typeof v.source === "string") b.source = v.source;
    return b;
  }
  if (v.kind === "paragraph") {
    if (typeof v.text !== "string") throw new Error(`内容结构无效：${where}.text 应为字符串`);
    const b: OfficeBlock = { kind: "paragraph", text: v.text };
    if (typeof v.source === "string") b.source = v.source;
    return b;
  }
  if (v.kind === "bullets") {
    if (!Array.isArray(v.items)) throw new Error(`内容结构无效：${where}.items 应为数组`);
    return {
      kind: "bullets",
      items: v.items.map((it, i) => {
        if (!isRecord(it) || typeof it.text !== "string") throw new Error(`内容结构无效：${where}.items[${i}].text 应为字符串`);
        const item: { text: string; source?: OfficeSource } = { text: it.text };
        if (typeof it.source === "string") item.source = it.source;
        return item;
      }),
    };
  }
  if (v.kind === "table") {
    return { kind: "table", table: asTable(v.table, `${where}.table`) };
  }
  if (v.kind === "image") {
    if (typeof v.image !== "string" || !v.image.trim()) throw new Error(`内容结构无效：${where}.image 应为图片名`);
    const b: OfficeBlock = { kind: "image", image: v.image.trim() };
    if (typeof v.caption === "string") b.caption = v.caption;
    if (typeof v.source === "string") b.source = v.source;
    return b;
  }
  throw new Error(`内容结构无效：${where}.kind 只支持 heading/paragraph/bullets/table/image`);
}

export function parseOfficeDocument(input: unknown): OfficeDocument {
  if (!isRecord(input)) throw new Error("内容结构无效：应为对象（含 format/title）");
  if (input.format !== "docx" && input.format !== "xlsx" && input.format !== "pptx") {
    throw new Error("内容结构无效：format 只支持 docx/xlsx/pptx");
  }
  if (typeof input.title !== "string" || !input.title.trim()) throw new Error("内容结构无效：title 应为非空字符串");
  const doc: OfficeDocument = { title: input.title.trim(), format: input.format };
  if (input.format === "xlsx") {
    if (!Array.isArray(input.sheets) || input.sheets.length === 0) {
      throw new Error("内容结构无效：xlsx 需要 sheets 数组（至少一张表）");
    }
    doc.sheets = input.sheets.map((s, i) => {
      if (!isRecord(s) || typeof s.name !== "string" || !s.name.trim()) {
        throw new Error(`内容结构无效：sheets[${i}].name 应为非空字符串`);
      }
      if (!Array.isArray(s.headers) || !Array.isArray(s.rows)) {
        throw new Error(`内容结构无效：sheets[${i}] 应含 headers/rows 数组`);
      }
      return {
        name: s.name.trim(),
        headers: s.headers.map((c, j) => asCell(c, `sheets[${i}].headers[${j}]`)),
        rows: s.rows.map((r, k) => {
          if (!Array.isArray(r)) throw new Error(`内容结构无效：sheets[${i}].rows[${k}] 应为数组`);
          return r.map((c, j) => asCell(c, `sheets[${i}].rows[${k}][${j}]`));
        }),
      };
    });
  } else {
    if (!Array.isArray(input.blocks)) throw new Error("内容结构无效：docx/pptx 需要 blocks 数组");
    doc.blocks = input.blocks.map((b, i) => asBlock(b, `blocks[${i}]`));
  }
  if (Array.isArray(input.images)) {
    doc.images = input.images.map((im, i) => {
      if (!isRecord(im) || typeof im.name !== "string" || !im.name.trim() || typeof im.data !== "string") {
        throw new Error(`内容结构无效：images[${i}] 应含 name/data（base64）`);
      }
      let bytes: Buffer;
      try { bytes = Buffer.from(im.data, "base64"); } catch { throw new Error(`内容结构无效：images[${i}].data 不是合法 base64`); }
      if (bytes.length < 8) throw new Error(`内容结构无效：images[${i}] 图片太小`);
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!isPng && !isJpeg) throw new Error(`内容结构无效：images[${i}] 只认 PNG/JPEG（按文件头识别，不看扩展名）`);
      return { name: im.name.trim(), data: im.data };
    });
  }
  return doc;
}

// ---- 事实核查 ----

/** 一条未核实的数字：出现位置 + 数值原文（不记来源以外的上下文）。 */
export interface VerificationItem {
  where: string;
  value: string;
}

export interface VerificationResult {
  /** 扫到的数字总数。 */
  total: number;
  /** 有来源的数字数。 */
  verified: number;
  /** 无来源的数字（逐条列出位置与值）。 */
  unverified: VerificationItem[];
}

/** 数字扫描：整数/小数/千分位/百分数；四位年份（1900–2099）不算事实数字。 */
const NUMBER_RE = /[0-9][0-9,]*(?:\.[0-9]+)?%?/g;

function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    if (/^(19|20)[0-9]{2}$/.test(m[0])) continue;
    out.push(m[0]);
  }
  return out;
}

/**
 * 事实核查：每个数字须有来源（段落/条目/单元格的 source 字段）。
 * 有来源 = 已核实；无来源 = 未核实（写出时按配置标“未核实”，不拒绝写出；
 * 拒绝写出会让“先出草稿再补来源”的正常流程走不通，见 docs/office.md）。
 * 核查结论进工具返回与 office_exported 事件；文件末尾另附核查小节。
 */
export function verifyOfficeDocument(doc: OfficeDocument): VerificationResult {
  let total = 0;
  let verified = 0;
  const unverified: VerificationItem[] = [];
  const checkText = (where: string, text: string, source?: OfficeSource) => {
    for (const n of numbersIn(text)) {
      total++;
      if (source) verified++;
      else unverified.push({ where, value: n });
    }
  };
  const checkCell = (where: string, cell: OfficeCell) => {
    if (typeof cell.value === "number") {
      total++;
      if (cell.source) verified++;
      else unverified.push({ where, value: String(cell.value) });
      return;
    }
    // 日期格（YYYY-MM-DD）里的年月日不是事实数字，不扫。
    if (cell.format === "date" && dateToSerial(cell.value) !== null) return;
    checkText(where, cell.value, cell.source);
  };
  const checkTable = (where: string, table: OfficeTable) => {
    table.headers.forEach((c, i) => checkCell(`${where} 表头第 ${i + 1} 列`, c));
    table.rows.forEach((row, r) => row.forEach((c, i) => checkCell(`${where} 第 ${r + 1} 行第 ${i + 1} 列`, c)));
  };
  if (doc.format === "xlsx") {
    for (const sheet of doc.sheets ?? []) {
      sheet.headers.forEach((c, i) => checkCell(`表 ${sheet.name} 表头第 ${i + 1} 列`, c));
      sheet.rows.forEach((row, r) => row.forEach((c, i) => checkCell(`表 ${sheet.name} 第 ${r + 1} 行第 ${i + 1} 列`, c)));
    }
    return { total, verified, unverified };
  }
  (doc.blocks ?? []).forEach((b, i) => {
    const where = `第 ${i + 1} 段`;
    if (b.kind === "heading" || b.kind === "paragraph") checkText(where, b.text, b.source);
    if (b.kind === "bullets") b.items.forEach((it, j) => checkText(`${where} 第 ${j + 1} 条`, it.text, it.source));
    if (b.kind === "table") checkTable(where, b.table);
    if (b.kind === "image" && b.caption) checkText(where, b.caption, b.source);
  });
  return { total, verified, unverified };
}

/** 正文里给无来源数字打标记：段落/条目/单元格文本后追加“（未核实）”。 */
function markText(text: string, source: OfficeSource | undefined, cfg: OfficeConfig): string {
  if (!cfg.markUnverified || source) return text;
  return numbersIn(text).length > 0 ? `${text}（未核实）` : text;
}

// ---- 最小 zip 写出（stored，不压缩；不引 zip 库） ----

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] as number ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer | string;
}

/** stored 方式写 zip：Office 能正常打开；条目原样存放，便于测试直接读回校验。 */
export function createZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === "string" ? Buffer.from(e.data, "utf-8") : e.data;
    const name = Buffer.from(e.name, "utf-8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt32LE(0, 36);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + data.length;
  }
  const centralDir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralDir, eocd]);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Excel 日期序列（1900 年系，含闰年 bug 的 1900-02-29 这一天）。 */
export function dateToSerial(ymd: string): number | null {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(ymd);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const utc = Date.UTC(y, mo - 1, d);
  const base = Date.UTC(1899, 11, 30);
  return Math.round((utc - base) / 86400000);
}

// ---- DOCX ----

function docxRun(text: string, bold = false, unverified = false): string {
  const props = bold ? "<w:rPr><w:b/></w:rPr>" : unverified ? "<w:rPr><w:color w:val=\"C00000\"/></w:rPr>" : "";
  return `<w:r>${props}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function docxParagraph(text: string, style?: string, numId?: number): string {
  let pr = "";
  if (style) pr += `<w:pStyle w:val="${style}"/>`;
  if (numId !== undefined) pr += `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`;
  return `<w:p>${pr ? `<w:pPr>${pr}</w:pPr>` : ""}${docxRun(text)}</w:p>`;
}

function docxTable(table: OfficeTable, cfg: OfficeConfig): string {
  const cols = Math.max(table.headers.length, ...table.rows.map((r) => r.length));
  const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="2400"/>`).join("");
  const cellXml = (cell: OfficeCell, header: boolean): string => {
    const text = typeof cell.value === "number" ? String(cell.value) : cell.value;
    const marked = markText(text, cell.source, cfg);
    const unverified = cfg.markUnverified && !cell.source && numbersIn(text).length > 0;
    const shading = header ? "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"D9D9D9\"/>" : "";
    return `<w:tc><w:tcPr>${shading}</w:tcPr><w:p>${docxRun(marked, header, unverified)}</w:p></w:tc>`;
  };
  const headerRow = `<w:tr><w:trPr><w:tblHeader w:val="true"/></w:trPr>${table.headers.map((c) => cellXml(c, true)).join("")}</w:tr>`;
  const bodyRows = table.rows.map((row) => `<w:tr>${row.map((c) => cellXml(c, false)).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`;
}

function docxVerificationSection(v: VerificationResult): string {
  const head = docxParagraph("事实核查", "Heading1");
  const summary = v.unverified.length === 0
    ? `共 ${v.total} 项数字，全部有来源。`
    : `共 ${v.total} 项数字，${v.verified} 项有来源，${v.unverified.length} 项未核实（正文里已标“未核实”）：`;
  const items = v.unverified.map((it) => docxParagraph(`${it.where}：${it.value}`, undefined, 1)).join("");
  return head + docxParagraph(summary) + items;
}

function buildDocx(doc: OfficeDocument, v: VerificationResult, cfg: OfficeConfig): Buffer {
  const body: string[] = [docxParagraph(doc.title, "Title")];
  for (const b of doc.blocks ?? []) {
    if (b.kind === "heading") {
      const text = markText(b.text, b.source, cfg);
      body.push(docxParagraph(text, `Heading${b.level}`));
    } else if (b.kind === "paragraph") {
      body.push(docxParagraph(markText(b.text, b.source, cfg)));
    } else if (b.kind === "bullets") {
      for (const it of b.items) body.push(docxParagraph(markText(it.text, it.source, cfg), "ListParagraph", 1));
    } else if (b.kind === "table") {
      body.push(docxTable(b.table, cfg));
    }
    // image 块在 DOCX 里不落地（图片进 PPTX 才有意义；DOCX 只留标题文字说明）。
    else if (b.kind === "image") {
      body.push(docxParagraph(`[图片：${b.caption ?? b.image}]`));
    }
  }
  body.push(docxVerificationSection(v));
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="480" w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="Normal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>`;
  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(doc.title)}</dc:title><dc:creator>Nyra</dc:creator></cp:coreProperties>`;
  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Nyra</Application></Properties>`;
  return createZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "word/_rels/document.xml.rels", data: docRels },
    { name: "word/document.xml", data: documentXml },
    { name: "word/styles.xml", data: stylesXml },
    { name: "word/numbering.xml", data: numberingXml },
    { name: "docProps/core.xml", data: coreXml },
    { name: "docProps/app.xml", data: appXml },
  ]);
}

// ---- XLSX ----

/** 表名清洗：禁 []:*?/\，最长 31 字，重名加 -2/-3。 */
export function sanitizeSheetName(name: string, used: Set<string>): string {
  let clean = name.replace(/[[\]:*?/\\]/g, "_").trim() || "Sheet";
  if (clean.length > 31) clean = clean.slice(0, 31);
  let out = clean;
  let n = 2;
  while (used.has(out)) {
    const suffix = `-${n}`;
    out = clean.slice(0, 31 - suffix.length) + suffix;
    n++;
  }
  used.add(out);
  return out;
}

function colLetter(i: number): string {
  let s = "";
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function xlsxCellXml(cell: OfficeCell, ref: string, header: boolean, cfg: OfficeConfig): string {
  const marked = typeof cell.value === "string" ? markText(cell.value, cell.source, cfg) : null;
  if (cell.formula) {
    const cached = typeof cell.value === "number" ? cell.value : 0;
    return `<c r="${ref}" s="2"><f>${esc(cell.formula)}</f><v>${cached}</v></c>`;
  }
  if (typeof cell.value === "number") {
    if (cell.format === "percent") return `<c r="${ref}" s="3"><v>${cell.value}</v></c>`;
    if (cell.format === "currency") return `<c r="${ref}" s="2"><v>${cell.value}</v></c>`;
    if (cell.format === "date") return `<c r="${ref}" s="4"><v>${cell.value}</v></c>`;
    return `<c r="${ref}"${header ? " s=\"1\"" : ""}><v>${cell.value}</v></c>`;
  }
  const text = marked ?? cell.value;
  if (cell.format === "date") {
    const serial = dateToSerial(cell.value);
    if (serial !== null) return `<c r="${ref}" s="4"><v>${serial}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${header ? " s=\"1\"" : ""}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function xlsxSheetXml(sheet: OfficeSheet, cfg: OfficeConfig): string {
  const cols = Math.max(sheet.headers.length, ...sheet.rows.map((r) => r.length));
  const widths: number[] = [];
  for (let i = 0; i < cols; i++) {
    let w = 10;
    const cells = [sheet.headers[i], ...sheet.rows.map((r) => r[i])].filter(Boolean) as OfficeCell[];
    for (const c of cells) w = Math.max(w, Math.min(40, String(c.value).length + 2));
    widths.push(w);
  }
  const colsXml = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const rows: string[] = [];
  const headerCells = sheet.headers.map((c, i) => xlsxCellXml(c, `${colLetter(i)}1`, true, cfg)).join("");
  rows.push(`<row r="1">${headerCells}</row>`);
  sheet.rows.forEach((row, r) => {
    const cells = row.map((c, i) => xlsxCellXml(c, `${colLetter(i)}${r + 2}`, false, cfg)).join("");
    rows.push(`<row r="${r + 2}">${cells}</row>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${colsXml}</cols><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

function buildXlsx(doc: OfficeDocument, v: VerificationResult, cfg: OfficeConfig): Buffer {
  const used = new Set<string>();
  const sheets = (doc.sheets ?? []).map((s) => ({ ...s, cleanName: sanitizeSheetName(s.name, used) }));
  // 未核实的数字另附一张“核查”表（数值格本身保持数值类型，不改成文本）。
  if (v.unverified.length > 0) {
    sheets.push({
      name: "核查",
      cleanName: sanitizeSheetName("核查", used),
      headers: [{ value: "位置" }, { value: "值" }, { value: "状态" }],
      rows: v.unverified.map((it) => [{ value: it.where }, { value: it.value }, { value: "未核实" }]),
    });
  }
  const entries: ZipEntry[] = [];
  const sheetRels = sheets.map((s, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.cleanName)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.00%"/><numFmt numFmtId="166" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  entries.push(
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "xl/workbook.xml", data: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: stylesXml },
  );
  sheets.forEach((s, i) => entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xlsxSheetXml(s, cfg) }));
  return createZip(entries);
}

// ---- PPTX ----

/** 幻灯片内容（由 blocks 折叠而来：标题起新页，表格/图片各占一页）。 */
interface PptxSlide {
  title: string;
  bullets: string[];
  table?: OfficeTable;
  image?: { name: string; caption?: string };
}

function pptxSlides(doc: OfficeDocument, cfg: OfficeConfig): PptxSlide[] {
  const slides: PptxSlide[] = [];
  let current: PptxSlide = { title: doc.title, bullets: [] };
  slides.push(current);
  let firstParagraphConsumed = false;
  for (const b of doc.blocks ?? []) {
    if (b.kind === "heading") {
      current = { title: markText(b.text, b.source, cfg), bullets: [] };
      slides.push(current);
    } else if (b.kind === "paragraph") {
      if (!firstParagraphConsumed && slides.length === 1 && current.bullets.length === 0) {
        // 标题页的第一段当副标题。
        current.bullets.push(markText(b.text, b.source, cfg));
        firstParagraphConsumed = true;
      } else {
        current.bullets.push(markText(b.text, b.source, cfg));
      }
    } else if (b.kind === "bullets") {
      for (const it of b.items) current.bullets.push(markText(it.text, it.source, cfg));
    } else if (b.kind === "table") {
      if (current.table || current.bullets.length > 0) {
        current = { title: current.title === doc.title ? "表格" : `${current.title}（续）`, bullets: [] };
        slides.push(current);
      }
      current.table = b.table;
    } else if (b.kind === "image") {
      current = { title: b.caption ?? b.image, bullets: [], image: { name: b.image, caption: b.caption } };
      slides.push(current);
    }
  }
  return slides;
}

function pptxTextBox(text: string, x: number, y: number, w: number, h: number, size: number, bold: boolean, bullet: boolean): string {
  const pPr = bullet ? `<a:pPr marL="228600" indent="-228600"><a:buChar char="•"/></a:pPr>` : "<a:pPr/>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="TextBox"/><p:cNvSpPr txBox="1"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p>${pPr}<a:r><a:rPr lang="zh-CN" sz="${size * 100}"${bold ? " b=\"1\"" : ""}/><a:t>${esc(text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function pptxTableXml(table: OfficeTable, cfg: OfficeConfig, x: number, y: number, w: number, h: number): string {
  const cols = Math.max(table.headers.length, ...table.rows.map((r) => r.length));
  const colW = Math.floor(w / cols);
  const grid = Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join("");
  const rowXml = (cells: OfficeCell[], header: boolean): string => {
    const tcs = cells.map((c) => {
      const text = typeof c.value === "number" ? String(c.value) : markText(c.value, c.source, cfg);
      const fill = header ? "<a:solidFill><a:srgbClr val=\"D9D9D9\"/></a:solidFill>" : "";
      return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1400"${header ? " b=\"1\"" : ""}/><a:t>${esc(text)}</a:t></a:r></a:p></a:txBody><a:tcPr>${fill}</a:tcPr></a:tc>`;
    }).join("");
    return `<a:tr h="370840">${tcs}</a:tr>`;
  };
  const rows = rowXml(table.headers, true) + table.rows.map((r) => rowXml(r, false)).join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/><p:cNvGraphicFramePr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/** 读图片宽高（PNG 读 IHDR，JPEG 扫 SOF0/SOF2；读不到回退 16:9）。 */
export function imageDimensions(data: Buffer): { width: number; height: number } {
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let off = 2;
    while (off + 9 < data.length) {
      if (data[off] !== 0xff) break;
      const marker = data[off + 1] as number;
      const len = data.readUInt16BE(off + 2);
      if (marker === 0xc0 || marker === 0xc2) {
        return { height: data.readUInt16BE(off + 5), width: data.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }
  return { width: 1600, height: 900 };
}

const PPTX_THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Nyra"><a:themeElements><a:clrScheme name="Nyra"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Nyra"><a:majorFont><a:latin typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme><a:fmtScheme name="Nyra"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

function buildPptx(doc: OfficeDocument, v: VerificationResult, cfg: OfficeConfig): Buffer {
  const images = new Map<string, Buffer>();
  for (const im of doc.images ?? []) images.set(im.name, Buffer.from(im.data, "base64"));
  const slides = pptxSlides(doc, cfg);
  // 事实核查单独一页。
  slides.push({
    title: "事实核查",
    bullets: v.unverified.length === 0
      ? [`共 ${v.total} 项数字，全部有来源。`]
      : [`共 ${v.total} 项数字，${v.verified} 项有来源，${v.unverified.length} 项未核实。`, ...v.unverified.map((it) => `${it.where}：${it.value}`)],
  });
  const entries: ZipEntry[] = [];
  const slideRels: string[] = [];
  slides.forEach((s, i) => slideRels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`));
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`;
  const presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideRels.join("")}</Relationships>`;
  const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr algn="l"><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr algn="l"><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
  const masterRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`;
  const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const layoutRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  entries.push(
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "ppt/presentation.xml", data: presentationXml },
    { name: "ppt/_rels/presentation.xml.rels", data: presRels },
    { name: "ppt/slideMasters/slideMaster1.xml", data: masterXml },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: masterRels },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: layoutXml },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: layoutRels },
    { name: "ppt/theme/theme1.xml", data: PPTX_THEME },
  );
  // 图片部件（只写被图片块实际引用的）。
  const mediaNames = new Map<string, string>();
  for (const s of slides) {
    if (!s.image) continue;
    const bytes = images.get(s.image.name);
    if (!bytes) continue;
    const ext = bytes[0] === 0x89 ? "png" : "jpg";
    const base = s.image.name.replace(/[^\w.-]/g, "_");
    const part = `media/${base.endsWith(`.${ext}`) ? base : `${base}.${ext}`}`;
    if (!mediaNames.has(s.image.name)) {
      mediaNames.set(s.image.name, part);
      entries.push({ name: `ppt/${part}`, data: bytes });
    }
  }
  slides.forEach((s, i) => {
    const shapes: string[] = [];
    const isTitle = i === 0;
    shapes.push(pptxTextBox(s.title, 457200, isTitle ? 1828800 : 274320, 11277600, 1000000, isTitle ? 40 : 28, true, false));
    let y = isTitle ? 3200000 : 1400000;
    if (s.image) {
      const bytes = images.get(s.image.name);
      if (bytes) {
        const dim = imageDimensions(bytes);
        const boxW = 9000000;
        const boxH = Math.min(4800000, Math.floor((boxW * dim.height) / dim.width));
        const part = mediaNames.get(s.image.name) as string;
        const rid = `rId2`;
        shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="4" name="${esc(s.image.name)}"/><p:cNvPicPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.floor((12192000 - boxW) / 2)}" y="${y}"/><a:ext cx="${boxW}" cy="${boxH}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`);
        y += boxH + 200000;
      }
    }
    if (s.table) {
      shapes.push(pptxTableXml(s.table, cfg, 457200, y, 11277600, 4200000));
    } else {
      for (const b of s.bullets) {
        shapes.push(pptxTextBox(b, 457200, y, 11277600, 500000, 18, false, true));
        y += 550000;
      }
    }
    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld></p:sld>`;
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml });
    const relsParts = [`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
    if (s.image && mediaNames.has(s.image.name)) {
      relsParts.push(`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../${mediaNames.get(s.image.name) as string}"/>`);
    }
    entries.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsParts.join("")}</Relationships>`,
    });
  });
  return createZip(entries);
}

// ---- 总入口 ----

export interface OfficeBuildResult {
  buffer: Buffer;
  verification: VerificationResult;
}

export function buildOffice(doc: OfficeDocument, cfg: OfficeConfig = DEFAULT_OFFICE_CONFIG): OfficeBuildResult {
  const verification = verifyOfficeDocument(doc);
  const buffer = doc.format === "docx" ? buildDocx(doc, verification, cfg)
    : doc.format === "xlsx" ? buildXlsx(doc, verification, cfg)
    : buildPptx(doc, verification, cfg);
  return { buffer, verification };
}

export interface OfficeExportResult {
  /** 写出的绝对路径。 */
  out: string;
  bytes: number;
  fileHash: string;
  verification: VerificationResult;
}

/**
 * 写出成品文件（工具与 CLI 共用）：校验结构 → 事实核查 → 写出器 → 落盘。
 * 超 maxBytes 拒绝；落盘 0600。事件只记元数据与指纹。
 */
export function exportOfficeDocument(doc: OfficeDocument, outAbs: string, cfg: OfficeConfig = DEFAULT_OFFICE_CONFIG): OfficeExportResult {
  const { buffer, verification } = buildOffice(doc, cfg);
  if (buffer.length > cfg.maxBytes) {
    throw new Error(`导出失败：文件 ${buffer.length} 字节，超过上限 ${cfg.maxBytes} 字节`);
  }
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, buffer);
  chmodSync(outAbs, 0o600);
  const fileHash = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  return { out: outAbs, bytes: buffer.length, fileHash, verification };
}

/**
 * CLI：nyra export --format docx|xlsx|pptx --from <内容 JSON> --out <路径>。
 * 退出码：0 成功、1 运行失败、2 用法错误。
 * --from 读结构化内容 JSON（不是任务产物导出：任务产物要先落盘成 JSON 再导）。
 */
export function handleExport(argv: string[], home: string, workdir: string): number {
  const usage = "用法：nyra export --format docx|xlsx|pptx --from <内容 JSON> --out <路径>";
  let format: string | undefined;
  let from: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--format" && i + 1 < argv.length) format = argv[++i];
    else if (arg.startsWith("--format=")) format = arg.slice("--format=".length);
    else if (arg === "--from" && i + 1 < argv.length) from = argv[++i];
    else if (arg.startsWith("--from=")) from = arg.slice("--from=".length);
    else if (arg === "--out" && i + 1 < argv.length) out = argv[++i];
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
    else {
      process.stderr.write(`${usage}\n未知参数：${arg}\n`);
      return 2;
    }
  }
  if (!format || !from || !out) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  if (format !== "docx" && format !== "xlsx" && format !== "pptx") {
    process.stderr.write(`格式不支持：${format}（只支持 docx/xlsx/pptx）\n`);
    return 2;
  }
  const fromAbs = resolve(workdir, from);
  if (!existsSync(fromAbs)) {
    process.stderr.write(`内容文件不存在：${from}\n`);
    return 1;
  }
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(fromAbs, "utf-8"));
  } catch (err) {
    process.stderr.write(`内容文件不是合法 JSON：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  let doc: OfficeDocument;
  try {
    doc = parseOfficeDocument(input);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (doc.format !== format) {
    process.stderr.write(`内容 format 是 ${doc.format}，与 --format ${format} 不一致\n`);
    return 1;
  }
  const cfg = resolveOfficeConfig(loadConfig(home) as Record<string, unknown>);
  const outAbs = resolve(workdir, out);
  try {
    const result = exportOfficeDocument(doc, outAbs, cfg);
    const v = result.verification;
    const base = basename(result.out);
    process.stdout.write(`已导出 ${base}（${doc.format}，${result.bytes} 字节；事实核查：${v.verified}/${v.total} 项已核实，${v.unverified.length} 项未核实）\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`导出失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
