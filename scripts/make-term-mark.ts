// scripts/make-term-mark.ts — 重新生成 src/termMarkImage.ts（终端欢迎屏用的标志 PNG，base64 常量），
// 并打印 src/termMark.ts 里半块字符画用的覆盖率常量 TERM_MARK_COVERAGE。
// 改了 src/brandMark.ts 的几何后跑一次：bun scripts/make-term-mark.ts
// （tests/node/test-term-mark.test.ts 会核对两者与 brandMark 现算的结果一致。）
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { termMarkCoverageRows, termMarkPng, TERM_MARK_PNG_PX } from "../src/termMarkSource.ts";

const out = join(import.meta.dir, "..", "src", "termMarkImage.ts");
const b64 = (light: boolean) => termMarkPng(light).toString("base64");
writeFileSync(out, [
  "// src/termMarkImage.ts — 由 scripts/make-term-mark.ts 生成，不要手改。",
  `// Nyra 标志（圆盘 + 光标，透明底、光标镂空透明）的 ${TERM_MARK_PNG_PX}×${TERM_MARK_PNG_PX} PNG，`,
  "// 支持内联图片的终端（kitty 图形协议 / iTerm2 内联图片）在欢迎屏上直接显示它。",
  "/** 深色终端用：浅色圆盘 #F5F5F7。 */",
  `export const TERM_MARK_PNG_DARK = "${b64(false)}";`,
  "/** 浅色终端用：深色圆盘 #0B0B0C。 */",
  `export const TERM_MARK_PNG_LIGHT = "${b64(true)}";`,
  "",
].join("\n"));
console.log(`wrote ${out}`);
console.log("TERM_MARK_COVERAGE:");
for (const r of termMarkCoverageRows()) console.log(`  "${r}",`);
