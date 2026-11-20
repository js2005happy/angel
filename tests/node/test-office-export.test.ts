// tests/node/test-office-export.test.ts — 缺口 23：成品级办公套件直出可编辑真文件。
// 假内容 + 真写出 + 真读回验证（手写最小 unzip 走 local header，校验 zip 结构与
// 核心 XML）：三种格式都能写出且读回、表格/公式/数值格式正确、路径逃逸拒绝、
// 事实核查（无来源数字标未核实）、写操作过审批、CLI 端到端。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOffice, createZip, dateToSerial, exportOfficeDocument, handleExport,
  imageDimensions, parseOfficeDocument, resolveOfficeConfig, sanitizeSheetName,
  verifyOfficeDocument, type OfficeDocument,
} from "../../src/office.ts";
import {
  HOOKED_TOOLS, MUTATING_TOOLS, SESSION_FILE_TOOLS, executeTool, newToolContext,
  type ToolContext,
} from "../../src/tools.ts";
import { DEFAULT_REVIEWED_TOOLS } from "../../src/reviewer.ts";

/** 1x1 透明 PNG（真 magic bytes + 真 IHDR，内容是假的）。 */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
const TEXT_BYTES = Buffer.from("这不是图片", "utf-8");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-office-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-office-wd-"));
  return { home, workdir };
}

function fullCtx(workdir: string, extra: Partial<ToolContext> = {}): ToolContext {
  return newToolContext({ workdir, mode: "full", interactive: false, ...extra });
}

/** 最小 unzip：只认 stored 条目（method 0），走 local header 提取。 */
function unzipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString("utf-8");
    const dataStart = off + 30 + nameLen + extraLen;
    expect(method).toBe(0);
    out.set(name, Buffer.from(buf.subarray(dataStart, dataStart + compSize)));
    off = dataStart + compSize;
  }
  return out;
}

function docxDoc(): OfficeDocument {
  return {
    title: "季度总结",
    format: "docx",
    blocks: [
      { kind: "heading", level: 1, text: "概览", source: "证据A" },
      { kind: "paragraph", text: "收入 100 万元，增长 20%。", source: "证据A" },
      { kind: "paragraph", text: "用户 500 人，2026 年上线。" },
      { kind: "bullets", items: [
        { text: "续费率 95%。", source: "证据B" },
        { text: "投诉 3 起。" },
      ] },
      { kind: "table", table: {
        headers: [{ value: "指标" }, { value: "数值" }],
        rows: [
          [{ value: "收入" }, { value: 100, source: "证据A" }],
          [{ value: "用户" }, { value: 500 }],
        ],
      } },
    ],
  };
}

function xlsxDoc(): OfficeDocument {
  return {
    title: "销售表",
    format: "xlsx",
    sheets: [{
      name: "销售",
      headers: [{ value: "产品" }, { value: "金额" }, { value: "占比" }, { value: "日期" }],
      rows: [
        [{ value: "A" }, { value: 1000, format: "currency", source: "财报" }, { value: 0.25, format: "percent", source: "财报" }, { value: "2026-01-15", format: "date", source: "财报" }],
        [{ value: "B" }, { value: 2000, formula: "SUM(B2:B2)" }, { value: 0.5, format: "percent" }, { value: "增长 12%" }],
        [{ value: "合计" }, { value: 3000, formula: "SUM(B2:B3)", source: "财报" }, { value: 0.75, format: "percent", source: "财报" }, { value: "" }],
      ],
    }],
  };
}

function pptxDoc(): OfficeDocument {
  return {
    title: "路演",
    format: "pptx",
    blocks: [
      { kind: "heading", level: 1, text: "市场", source: "研报" },
      { kind: "paragraph", text: "市场规模 80 亿。", source: "研报" },
      { kind: "bullets", items: [{ text: "增速 15%。", source: "研报" }] },
      { kind: "table", table: {
        headers: [{ value: "年" }, { value: "收入" }],
        rows: [[{ value: "2026" }, { value: 80, source: "研报" }]],
      } },
      { kind: "image", image: "chart.png", caption: "趋势图" },
    ],
    images: [{ name: "chart.png", data: PNG_1X1 }],
  };
}

// ---- 结构校验与事实核查 ----

test("OfficeExportTest.test_parse_rejects_bad_shape", () => {
  expect(() => parseOfficeDocument({ format: "pdf", title: "x", blocks: [] })).toThrow(/format 只支持/);
  expect(() => parseOfficeDocument({ format: "docx", title: "  ", blocks: [] })).toThrow(/title 应为非空/);
  expect(() => parseOfficeDocument({ format: "docx", title: "x" })).toThrow(/blocks 数组/);
  expect(() => parseOfficeDocument({ format: "xlsx", title: "x", sheets: [] })).toThrow(/至少一张表/);
  expect(() => parseOfficeDocument({ format: "docx", title: "x", blocks: [{ kind: "heading", level: 4, text: "y" }] })).toThrow(/level 只支持/);
  expect(() => parseOfficeDocument({ format: "xlsx", title: "x", sheets: [{ name: "s", headers: [{ value: true }], rows: [] }] })).toThrow(/value 应为字符串或数字/);
  expect(() => parseOfficeDocument({ format: "pptx", title: "x", blocks: [], images: [{ name: "a.png", data: TEXT_BYTES.toString("base64") }] })).toThrow(/只认 PNG\/JPEG/);
});

test("OfficeExportTest.test_verify_counts_and_year_excluded", () => {
  const v = verifyOfficeDocument(docxDoc());
  // 100/20（段落）、95（条目）、100（表格）已核实；500（段落）、3（条目）、500（表格）未核实；2026 年份不算。
  expect(v.total).toBe(7);
  expect(v.verified).toBe(4);
  expect(v.unverified).toHaveLength(3);
  expect(v.unverified.map((it) => it.value).sort()).toEqual(["3", "500", "500"]);
  const xv = verifyOfficeDocument(xlsxDoc());
  // 1000/0.25 已核实；2000/0.5/12 未核实；3000/0.75 已核实；日期格不算。
  expect(xv.total).toBe(7);
  expect(xv.verified).toBe(4);
  expect(xv.unverified).toHaveLength(3);
  const pv = verifyOfficeDocument(pptxDoc());
  expect(pv.total).toBe(3);
  expect(pv.verified).toBe(3);
  expect(pv.unverified).toHaveLength(0);
});

test("OfficeExportTest.test_date_serial_and_sheet_names", () => {
  expect(dateToSerial("2026-01-01")).toBe(46023);
  expect(dateToSerial("2026-01-15")).toBe(46037);
  expect(dateToSerial("2026-13-01")).toBeNull();
  expect(dateToSerial("不是日期")).toBeNull();
  const used = new Set<string>();
  expect(sanitizeSheetName("销售:2026/01", used)).toBe("销售_2026_01");
  expect(sanitizeSheetName("销售:2026/01", used)).toBe("销售_2026_01-2");
  expect(sanitizeSheetName("a".repeat(40), used)).toHaveLength(31);
});

test("OfficeExportTest.test_image_dimensions", () => {
  expect(imageDimensions(Buffer.from(PNG_1X1, "base64"))).toEqual({ width: 1, height: 1 });
  // JPEG 无 SOF 段：回退默认 16:9，不抛错。
  expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toEqual({ width: 1600, height: 900 });
});

test("OfficeExportTest.test_resolve_office_config_falls_back", () => {
  expect(resolveOfficeConfig(null)).toEqual({ maxBytes: 10 * 1024 * 1024, markUnverified: true });
  expect(resolveOfficeConfig({ office: { max_bytes: -5, mark_unverified: "yes" } })).toEqual({ maxBytes: 10 * 1024 * 1024, markUnverified: true });
  expect(resolveOfficeConfig({ office: { max_bytes: 100, mark_unverified: false } })).toEqual({ maxBytes: 100, markUnverified: false });
});

// ---- zip 与三种格式写出读回 ----

test("OfficeExportTest.test_create_zip_roundtrip", () => {
  const zip = createZip([
    { name: "a.txt", data: "hello" },
    { name: "dir/b.bin", data: Buffer.from([0, 1, 2, 255]) },
  ]);
  const entries = unzipEntries(zip);
  expect([...entries.keys()].sort()).toEqual(["a.txt", "dir/b.bin"]);
  expect(entries.get("a.txt")?.toString("utf-8")).toBe("hello");
  expect([...(entries.get("dir/b.bin") ?? [])]).toEqual([0, 1, 2, 255]);
  // EOCD 在末尾：条目数与 central 目录一致。
  expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(2);
});

test("OfficeExportTest.test_docx_writes_and_reads_back", () => {
  const { buffer, verification } = buildOffice(docxDoc());
  expect(verification.total).toBe(7);
  const entries = unzipEntries(buffer);
  expect([...entries.keys()].sort()).toEqual([
    "[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml",
    "word/_rels/document.xml.rels", "word/document.xml", "word/numbering.xml", "word/styles.xml",
  ]);
  const xml = entries.get("word/document.xml")?.toString("utf-8") ?? "";
  expect(xml).toContain("季度总结");
  expect(xml).toContain("收入 100 万元，增长 20%。");
  expect(xml).toContain("用户 500 人，2026 年上线。（未核实）");
  expect(xml).toContain("投诉 3 起。（未核实）");
  expect(xml).toContain("500（未核实）");
  expect(xml).toContain("事实核查");
  expect(xml).toContain("共 7 项数字，4 项有来源，3 项未核实");
  expect(xml).toContain("TableGrid");
  expect(entries.get("word/styles.xml")?.toString("utf-8")).toContain("Heading1");
  expect(entries.get("word/numbering.xml")?.toString("utf-8")).toContain("•");
});

test("OfficeExportTest.test_xlsx_writes_formula_and_formats", () => {
  const { buffer, verification } = buildOffice(xlsxDoc());
  expect(verification.total).toBe(7);
  const entries = unzipEntries(buffer);
  expect([...entries.keys()].sort()).toEqual([
    "[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels",
    "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
  ]);
  const workbook = entries.get("xl/workbook.xml")?.toString("utf-8") ?? "";
  expect(workbook).toContain("销售");
  expect(workbook).toContain("核查");
  const sheet1 = entries.get("xl/worksheets/sheet1.xml")?.toString("utf-8") ?? "";
  expect(sheet1).toContain("<f>SUM(B2:B3)</f>");
  expect(sheet1).toContain("<v>3000</v>");
  // 数值格保持数值类型（不是带“未核实”的文本），货币/百分比/日期各有样式。
  expect(sheet1).toContain("<v>2000</v>");
  expect(sheet1).not.toContain("2000（未核实）");
  expect(sheet1).toContain("s=\"2\"");
  expect(sheet1).toContain("s=\"3\"");
  expect(sheet1).toContain("<v>46037</v>");
  // 字符串格里的未核实数字照常标。
  expect(sheet1).toContain("增长 12%（未核实）");
  const check = entries.get("xl/worksheets/sheet2.xml")?.toString("utf-8") ?? "";
  expect(check).toContain("未核实");
  expect(check).toContain("2000");
  const styles = entries.get("xl/styles.xml")?.toString("utf-8") ?? "";
  expect(styles).toContain("0.00%");
  expect(styles).toContain("yyyy-mm-dd");
});

test("OfficeExportTest.test_xlsx_no_check_sheet_when_all_verified", () => {
  const doc: OfficeDocument = {
    title: "干净表", format: "xlsx",
    sheets: [{ name: "s", headers: [{ value: "a" }], rows: [[{ value: 1, source: "x" }]] }],
  };
  const entries = unzipEntries(buildOffice(doc).buffer);
  expect(entries.get("xl/workbook.xml")?.toString("utf-8")).not.toContain("核查");
  expect([...entries.keys()]).not.toContain("xl/worksheets/sheet2.xml");
});

test("OfficeExportTest.test_pptx_writes_slides_and_image", () => {
  const { buffer, verification } = buildOffice(pptxDoc());
  expect(verification.total).toBe(3);
  const entries = unzipEntries(buffer);
  const names = [...entries.keys()].sort();
  expect(names).toContain("ppt/presentation.xml");
  expect(names).toContain("ppt/slides/slide1.xml");
  expect(names).toContain("ppt/slides/slide5.xml");
  expect(names).toContain("ppt/slides/slide4.xml");
  expect(names).toContain("ppt/theme/theme1.xml");
  expect(names).toContain("ppt/media/chart.png");
  const pres = entries.get("ppt/presentation.xml")?.toString("utf-8") ?? "";
  expect((pres.match(/<p:sldId /g) ?? []).length).toBe(5);
  expect(entries.get("ppt/slides/slide1.xml")?.toString("utf-8")).toContain("路演");
  expect(entries.get("ppt/slides/slide2.xml")?.toString("utf-8")).toContain("市场");
  expect(entries.get("ppt/slides/slide2.xml")?.toString("utf-8")).toContain("市场规模 80 亿。");
  expect(entries.get("ppt/slides/slide3.xml")?.toString("utf-8")).toContain("a:tbl");
  const imageSlide = entries.get("ppt/slides/slide4.xml")?.toString("utf-8") ?? "";
  expect(imageSlide).toContain("<p:pic");
  expect(imageSlide).toContain("r:embed=\"rId2\"");
  const imageRels = entries.get("ppt/slides/_rels/slide4.xml.rels")?.toString("utf-8") ?? "";
  expect(imageRels).toContain("relationships/image");
  expect(imageRels).toContain("media/chart.png");
  const checkSlide = entries.get("ppt/slides/slide5.xml")?.toString("utf-8") ?? "";
  expect(checkSlide).toContain("事实核查");
  expect(checkSlide).toContain("共 3 项数字，全部有来源。");
});

// ---- 工具接线：审批、逃逸、后端、事件 ----

test("OfficeExportTest.test_tool_sets_include_export_office", () => {
  expect(MUTATING_TOOLS.has("export_office")).toBe(true);
  expect(HOOKED_TOOLS.has("export_office")).toBe(true);
  expect(SESSION_FILE_TOOLS.has("export_office")).toBe(true);
  expect(DEFAULT_REVIEWED_TOOLS).toContain("export_office");
});

test("OfficeExportTest.test_tool_export_end_to_end", async () => {
  const { workdir } = setup();
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  const ctx = fullCtx(workdir, { onEvent: (kind, data) => events.push({ kind, data }) });
  const result = await executeTool("export_office", {
    format: "docx", title: "季度总结", blocks: docxDoc().blocks, out: "out/报告.docx",
  }, ctx);
  expect(result).toContain("已导出 out/报告.docx");
  expect(result).toContain("事实核查：4/7 项已核实，3 项未核实");
  const target = join(workdir, "out", "报告.docx");
  expect(existsSync(target)).toBe(true);
  expectPerms(target, 0o600);
  const exported = events.find((e) => e.kind === "office_exported");
  expect(exported).toBeDefined();
  expect(exported?.data.format).toBe("docx");
  expect(typeof exported?.data.bytes).toBe("number");
  expect(exported?.data.verified).toBe(4);
  expect(exported?.data.unverified).toBe(3);
  expect(String(exported?.data.file_hash)).toMatch(/^[0-9a-f]{12}$/);
  // 事件里不记绝对路径与文件全文。
  expect(JSON.stringify(exported?.data)).not.toContain(workdir);
});

test("OfficeExportTest.test_tool_export_approval_refusal", async () => {
  const { workdir } = setup();
  const ctx = newToolContext({ workdir, mode: "auto", interactive: true, approveFn: async () => false });
  const result = await executeTool("export_office", {
    format: "docx", title: "x", blocks: [{ kind: "paragraph", text: "hi" }], out: "out/报告.docx",
  }, ctx);
  expect(result.startsWith("错误")).toBe(true);
  expect(existsSync(join(workdir, "out", "报告.docx"))).toBe(false);
});

test("OfficeExportTest.test_tool_export_path_escape_refused", async () => {
  const { workdir } = setup();
  const ctx = fullCtx(workdir);
  const result = await executeTool("export_office", {
    format: "docx", title: "x", blocks: [{ kind: "paragraph", text: "hi" }], out: "../逃逸.docx",
  }, ctx);
  expect(result.startsWith("错误")).toBe(true);
  expect(existsSync(join(workdir, "..", "逃逸.docx"))).toBe(false);
});

test("OfficeExportTest.test_tool_export_backend_refused", async () => {
  const { workdir } = setup();
  const ctx = fullCtx(workdir, { backend: { name: "e2b" } });
  const result = await executeTool("export_office", {
    format: "docx", title: "x", blocks: [{ kind: "paragraph", text: "hi" }], out: "out/报告.docx",
  }, ctx);
  expect(result).toContain("远端后端不支持");
  expect(existsSync(join(workdir, "out", "报告.docx"))).toBe(false);
});

test("OfficeExportTest.test_tool_export_bad_structure", async () => {
  const { workdir } = setup();
  const ctx = fullCtx(workdir);
  const result = await executeTool("export_office", {
    format: "pdf", title: "x", blocks: [], out: "out/报告.pdf",
  }, ctx);
  expect(result.startsWith("错误")).toBe(true);
});

test("OfficeExportTest.test_export_max_bytes_refused", () => {
  const { workdir } = setup();
  const cfg = resolveOfficeConfig({ office: { max_bytes: 10 } });
  expect(() => exportOfficeDocument(docxDoc(), join(workdir, "a.docx"), cfg)).toThrow(/超过上限/);
});

// ---- CLI 端到端 ----

function captureOutput(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(String(s)); return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(String(s)); return true; };
  return { chunks, restore: () => {
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
  } };
}

test("OfficeExportTest.test_cli_export_three_formats", async () => {
  const { home, workdir } = setup();
  const docs: [string, OfficeDocument][] = [
    ["docx", docxDoc()],
    ["xlsx", xlsxDoc()],
    ["pptx", pptxDoc()],
  ];
  for (const [fmt, doc] of docs) {
    const inPath = join(workdir, `in-${fmt}.json`);
    writeFileSync(inPath, JSON.stringify(doc));
    const out = `out/成品.${fmt}`;
    const cap = captureOutput();
    let code: number;
    try {
      code = handleExport(["--format", fmt, "--from", inPath, "--out", out], home, workdir);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    expect(cap.chunks.join("")).toContain("已导出");
    expect(existsSync(join(workdir, out))).toBe(true);
  }
});

test("OfficeExportTest.test_cli_export_bad_args", async () => {
  const { home, workdir } = setup();
  const cap = captureOutput();
  try {
    expect(handleExport(["--format", "pdf", "--from", "in.json", "--out", "o.pdf"], home, workdir)).toBe(2);
    expect(handleExport(["--format", "docx"], home, workdir)).toBe(2);
    expect(handleExport(["--bogus"], home, workdir)).toBe(2);
    expect(handleExport(["--format", "docx", "--from", "no-such.json", "--out", "o.docx"], home, workdir)).toBe(1);
  } finally {
    cap.restore();
  }
  expect(cap.chunks.join("")).toContain("用法：nyra export");
});

test("OfficeExportTest.test_cli_export_bad_json_and_mismatch", async () => {
  const { home, workdir } = setup();
  writeFileSync(join(workdir, "bad.json"), "{ 不是 json");
  writeFileSync(join(workdir, "mismatch.json"), JSON.stringify(xlsxDoc()));
  const cap = captureOutput();
  try {
    expect(handleExport(["--format", "docx", "--from", "bad.json", "--out", "o.docx"], home, workdir)).toBe(1);
    expect(handleExport(["--format", "docx", "--from", "mismatch.json", "--out", "o.docx"], home, workdir)).toBe(1);
    expect(handleExport(["--format", "xlsx", "--from", "mismatch.json", "--out", "o.xlsx"], home, workdir)).toBe(0);
  } finally {
    cap.restore();
  }
  expect(existsSync(join(workdir, "o.xlsx"))).toBe(true);
});
