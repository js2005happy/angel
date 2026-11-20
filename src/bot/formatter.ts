// src/bot/formatter.ts — Bot 方向 Phase 1：按平台限制做安全分片。
//
// Telegram 单条消息上限 4096 字符；超了直接发会报 400。分片的规矩：
//   - 优先在空行（段落边界）切，其次单换行，再次空格，最后才硬切；
//   - ``` 代码围栏不能拦腰切断：切开时上片补一个收尾围栏、下片重开一个，
//     否则两边都变不成代码块；
//   - 默认按 4000 切（留 96 字符余量给平台侧的收尾处理）。
// Phase 1 用纯文本发送（不设 parse_mode），所以不做 MarkdownV2 转义；
// escapeMarkdownV2 留给以后要发富格式时用。
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
/** 默认分片上限（比平台上限留一点余量）。 */
export const DEFAULT_SPLIT_LIMIT = 4000;

const FENCE = "```";

/** 判断 text 里从头数到 pos 处是否在 ``` 围栏内（奇数个围栏标记 = 在里面）。 */
export function insideFence(text: string, pos: number): boolean {
  const head = text.slice(0, pos);
  const marks = head.split(FENCE).length - 1;
  return marks % 2 === 1;
}

function findBreak(text: string, from: number, to: number): number {
  // 空行优先（段落边界），再单换行，再空格；都没有就硬切。
  const blank = text.lastIndexOf("\n\n", to);
  if (blank > from) return blank + 2;
  const nl = text.lastIndexOf("\n", to);
  if (nl > from) return nl + 1;
  const space = text.lastIndexOf(" ", to);
  if (space > from) return space + 1;
  return to;
}

/**
 * 把长文本按 limit 切成多片。空文本返回 []；短文本原样返回一片。
 * 围栏处理：某片在围栏内结束时补收尾围栏，下一片开头重开围栏。
 */
export function splitMessage(text: string, limit = DEFAULT_SPLIT_LIMIT): string[] {
  if (!text) return [];
  const max = Math.max(100, Math.floor(limit));
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let start = 0;
  let openFence = false;
  while (start < text.length) {
    const rest = text.length - start;
    if (rest <= max) {
      chunks.push((openFence ? FENCE + "\n" : "") + text.slice(start));
      break;
    }
    let end = findBreak(text, start, start + max);
    // 别在围栏标记中间切：切点落在 ``` 上时往后挪到标记之后。
    const fenceAt = text.indexOf(FENCE, end - 2);
    if (fenceAt >= start && fenceAt < end + FENCE.length) end = fenceAt + FENCE.length;
    let piece = text.slice(start, end);
    const fenceBefore = openFence;
    // 本片新开的围栏数（奇数 = 本片结束时围栏还开着）。
    const opened = piece.split(FENCE).length - 1;
    if (fenceBefore) piece = FENCE + "\n" + piece;
    if ((fenceBefore ? 1 : 0) + opened > 0 && ((fenceBefore ? 1 : 0) + opened) % 2 === 1) {
      piece = piece + "\n" + FENCE;
      openFence = true;
    } else {
      openFence = false;
    }
    chunks.push(piece);
    start = end;
    // 切点落在换行符上时跳过它，避免下片开头多个空行。
    while (start < text.length && text[start] === "\n" && chunks[chunks.length - 1].endsWith("\n")) start++;
  }
  return chunks.filter((c) => c.length > 0);
}

/** Telegram MarkdownV2 转义（发富格式时用；纯文本发送不需要）。 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/** 审计/日志里用的文本摘要（不把用户原文写进日志，只留长度与首行）。 */
export function textSummary(text: string, maxLen = 80): string {
  const first = (text.split("\n")[0] ?? "").trim();
  const shown = first.length > maxLen ? first.slice(0, maxLen) + "…" : first;
  return `${text.length} 字：${shown}`;
}
