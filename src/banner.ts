// src/banner.ts — NYRA 字标横幅，与 Python 版 nyra/banner.py 逐字一致。
// 字标是 11 行 × 最宽 42 列的 ### 块字（用户定稿），在 60 列字段内居中；
// 彩色版用金色（gold），无色版无任何 ANSI。
export const WORDMARK: string[] = [
  "###   ###  ###   ###  ######        ###",
  "###   ###  ###   ###  ###  ###     #####",
  "##### ###  ###   ###  ###  ###     ## ##",
  "##### ###   ### ###   ###  ###    ##   ##",
  "### #####    #####    ######      ##   ##",
  "### #####     ###     ### ###    ###   ###",
  "###  ####     ###     ###  ###   #########",
  "###  ####     ###     ###   ###  ###   ###",
  "###   ###     ###     ###   ###  ###   ###",
  "###   ###     ###     ###   ###  ###   ###",
  "###   ###     ###     ###   ###  ###   ###",
];

const FIELD_WIDTH = 60;

function centre(lines: string[]): string[] {
  const pad = Math.max(0, Math.floor((FIELD_WIDTH - Math.max(...lines.map((l) => l.length))) / 2));
  return lines.map((l) => " ".repeat(pad) + l);
}

const GOLD = "\x1b[33m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function style(text: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

export function wordmarkLines(color = false): string[] {
  const lines = centre(WORDMARK);
  if (!color) return lines;
  return lines.map((line, i) => style(line, i === 0 ? `${GOLD}${BOLD}` : GOLD, true));
}

export function renderBanner(
  version: string,
  providerDesc: string,
  mode: string,
  sessionId: string,
  color = false,
): string {
  const label = (text: string) => style(text, DIM, color);
  const title = style(`Nyra ${version}`, BOLD, color);
  const modelLabel = style("模型：", `${GOLD}${BOLD}`, color);
  const model = style(providerDesc, BOLD, color);
  const lines = wordmarkLines(color);
  lines.push(
    `${title}  ${label("全能 AI 助手 · Node 运行时")}`,
    `${modelLabel}${model}`,
    `${label("模式：")}${mode}`,
    `${label("会话：")}${sessionId}`,
  );
  return lines.join("\n");
}
