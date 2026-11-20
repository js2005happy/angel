// src/termMarkSource.ts — 终端标志的“源”：从 src/brandMark.ts 现算半块字符画的覆盖率网格与内联图片 PNG。
// 运行时不加载（启动不光栅化）；只给 scripts/make-term-mark.ts 生成常量、给测试核对常量用。
import { rasterizeMark, markPng, MARK_INK, MARK_PAPER, MARK_STROKE } from "./brandMark.ts";
import { TERM_MARK_PX } from "./termMark.ts";

/** 内联图片 PNG 的边长（像素）：18 列宽在高分屏上约 300 物理像素，256 足够清楚，单张 < 3 KB。 */
export const TERM_MARK_PNG_PX = 256;
/** 圆盘占图片的比例：四周留一点边，抗锯齿不贴边，字符格比例偏扁时也不压到下一行。 */
export const TERM_MARK_PNG_DISC = 0.96;

/** 覆盖率网格（每行 TERM_MARK_PX 个十六进制数字，0 = 空、f = 全满）。 */
export function termMarkCoverageRows(px = TERM_MARK_PX): string[] {
  const a = rasterizeMark(px, { disc: "#FFFFFF", bg: null, discFraction: 1, stroke: MARK_STROKE });
  const rows: string[] = [];
  for (let y = 0; y < px; y++) {
    let s = "";
    for (let x = 0; x < px; x++) s += Math.round((a[(y * px + x) * 4 + 3] / 255) * 15).toString(16);
    rows.push(s);
  }
  return rows;
}

/** 内联图片：透明底，光标镂空透明（露出终端底色 = 入场动画终帧）；浅色终端用深色圆盘。 */
export function termMarkPng(light: boolean): Buffer {
  return markPng(TERM_MARK_PNG_PX, { disc: light ? MARK_INK : MARK_PAPER, bg: null, discFraction: TERM_MARK_PNG_DISC, stroke: MARK_STROKE });
}
