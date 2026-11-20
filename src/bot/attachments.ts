// src/bot/attachments.ts — Bot 方向 Phase 3：附件下载与解析。
//
// Telegram 消息带图片/文件时：先下载到临时目录（mkdtemp，0600），再按
// 类型处理，处理完立即删掉临时文件，不落盘留痕。
//
// 三条硬边界：
//   - 大小上限（默认 10MB）：超了直接跳过并回一句说明，不下载、不解析；
//   - 类型白名单：图片只认 PNG/JPEG/WebP/GIF（按 magic bytes 认，不信
//     扩展名）；文档只提取纯文本类（txt/md/json/csv/log/yaml/yml），其
//     他类型（pdf/docx/可执行文件等）一律不碰、不解析、不执行；
//   - 图片没有接视觉模型：本批只记元信息（尺寸、大小）并老实说“暂不支
//     持看图”，绝不假装看懂；文本文档提取的内容进 Agent 上下文，超长截
//     断并注明。
//
// 失败一律回明确说明，不静默丢弃：下载失败、超限、类型不在白名单、空
// 文件，都有对应的 notice；临时目录无论成败都在 finally 里删掉。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelAdapter, InboundMessage } from "./types.ts";

/** 一条消息最多处理几个附件（多了只处理前 N 个，其余回一句说明）。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/** 可提取文本的文档扩展名（小写）。 */
export const TEXT_EXTENSIONS = ["txt", "md", "markdown", "json", "csv", "log", "yaml", "yml"];

export type AttachmentKind = "image" | "text" | "unsupported";

export interface AttachmentOutcome {
  kind: AttachmentKind;
  /** 给用户的说明（失败/不支持时回这句；成功时为元信息行）。 */
  notice: string;
  /** 文本文档提取的内容（进 Agent 上下文；图片与不支持的类型没有）。 */
  extractedText?: string;
  /** 审计用的元信息（类型、大小，不含内容）。 */
  meta: { kind: string; name?: string; sizeBytes?: number; width?: number; height?: number };
}

export interface AttachmentProcessOptions {
  /** 单个附件下载上限（字节）。 */
  maxBytes: number;
  /** 单个文本文档提取进上下文的字符上限。 */
  textChars: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `约 ${(n / 1024).toFixed(0)} KB`;
  return `约 ${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string | undefined): string {
  if (!name) return "";
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 按 magic bytes 认图片类型（不信扩展名与 mime）。 */
export function sniffImageKind(bytes: Buffer): "png" | "jpeg" | "webp" | "gif" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a")) return "gif";
  return null;
}

/** 处理单个附件：下载 → 校验 → 提取/记元信息 → 删临时文件。 */
export async function processAttachment(
  adapter: ChannelAdapter,
  att: InboundMessage["attachments"][number],
  opts: AttachmentProcessOptions,
): Promise<AttachmentOutcome> {
  const meta: AttachmentOutcome["meta"] = { kind: att.kind, name: att.name, sizeBytes: att.sizeBytes, width: att.width, height: att.height };
  if (typeof adapter.downloadFile !== "function") {
    return { kind: "unsupported", notice: "当前渠道不支持下载附件，请把内容贴成文字再发。", meta };
  }
  let downloaded: { bytes: Buffer; fileName?: string; mimeType?: string };
  try {
    downloaded = await adapter.downloadFile(att.fileId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: "unsupported", notice: `附件下载失败（${reason}），请重试或把内容贴成文字。`, meta };
  }
  const bytes = downloaded.bytes;
  if (bytes.length === 0) {
    return { kind: "unsupported", notice: "附件是空文件，已跳过。", meta };
  }
  if (bytes.length > opts.maxBytes) {
    return { kind: "unsupported", notice: `附件太大（${formatBytes(bytes.length)}，超过 ${formatBytes(opts.maxBytes)} 上限），已跳过。`, meta: { ...meta, sizeBytes: bytes.length } };
  }
  // 落临时目录再处理（文件名不用平台给的名字，防路径穿越）；无论成败都删。
  const dir = mkdtempSync(join(tmpdir(), "nyra-bot-attachment-"));
  try {
    writeFileSync(join(dir, "file"), bytes, { mode: 0o600 });
    const data = readFileSync(join(dir, "file"));
    const imageKind = sniffImageKind(data);
    if (imageKind) {
      const dims = att.width && att.height ? `${att.width}×${att.height}` : "尺寸未知";
      return {
        kind: "image",
        notice: `收到一张图片（${dims}，${formatBytes(data.length)}）：本批暂不支持看图，已记录元信息，未进模型。`,
        meta: { ...meta, kind: "photo", sizeBytes: data.length },
      };
    }
    const ext = extensionOf(att.name ?? downloaded.fileName);
    const mime = (att.mimeType ?? downloaded.mimeType ?? "").toLowerCase();
    const isText = TEXT_EXTENSIONS.includes(ext) || mime.startsWith("text/");
    if (!isText) {
      const shown = ext ? `.${ext}` : (mime || "未知类型");
      return { kind: "unsupported", notice: `暂不支持解析这类文件（${shown}），请把内容贴成文字或转成 .txt/.md 再发。`, meta: { ...meta, sizeBytes: data.length } };
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(data);
    const truncated = decoded.length > opts.textChars;
    const extractedText = truncated ? decoded.slice(0, opts.textChars) : decoded;
    const name = att.name ?? downloaded.fileName ?? "未命名文档";
    return {
      kind: "text",
      notice: `已读取文档 ${name}（${formatBytes(data.length)}${truncated ? `，内容过长只取前 ${opts.textChars} 字` : ""}）。`,
      extractedText,
      meta: { ...meta, sizeBytes: data.length },
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export interface AttachmentsResult {
  outcomes: AttachmentOutcome[];
  /** 所有文本文档提取的内容拼成的上下文（进 Agent 的提示词；没有时为空串）。 */
  extractedText: string;
  /** 给用户的说明行（每条附件一句；超过上限时多一句）。 */
  notices: string[];
}

/** 处理一条消息的全部附件（最多前 5 个）。 */
export async function processAttachments(
  adapter: ChannelAdapter,
  attachments: InboundMessage["attachments"],
  opts: AttachmentProcessOptions,
): Promise<AttachmentsResult> {
  const outcomes: AttachmentOutcome[] = [];
  const parts: string[] = [];
  const limited = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  for (const att of limited) {
    const out = await processAttachment(adapter, att, opts);
    outcomes.push(out);
    if (out.kind === "text" && out.extractedText) {
      const name = out.meta.name ?? "未命名文档";
      parts.push(`[附件 ${name} 的内容]\n${out.extractedText}`);
    }
  }
  const notices = outcomes.map((o) => o.notice);
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    notices.push(`附件太多，只处理了前 ${MAX_ATTACHMENTS_PER_MESSAGE} 个。`);
  }
  return { outcomes, extractedText: parts.join("\n\n"), notices };
}
