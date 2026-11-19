// src/spinner.ts — 思考中的单行 spinner：主色转圈 + 短动词 + 已用秒数（+ 可选的小伙伴小脸）。
// 只在 TTY 上动；非 TTY（管道、日志、CI 重定向）完全不输出，保证纯文本输出干净。
// 每帧都是 "\r 清行 + 内容"，不换行；pause() 清掉这一行，好让工具输出正常打印。
import { BRAND, paint, type ColorLevel } from "./theme.ts";
import { textWidth, truncateWidth } from "./consoleUi.ts";

export const SPINNER_FRAMES_UNICODE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_FRAMES_ASCII = ["|", "/", "-", "\\"];

export interface SpinnerOpts {
  write: (s: string) => void;
  tty: boolean;
  level?: ColorLevel;
  unicode?: boolean;
  label?: string;
  intervalMs?: number;
  now?: () => number;
  width?: () => number;
  /** 每帧的小伙伴小脸（null = 不显示），右对齐到 faceCol 列。 */
  face?: (tick: number) => string | null;
  faceCol?: () => number | null;
}

/** 纯函数：一帧的文本。 */
export function spinnerLine(opts: {
  tick: number; elapsedMs: number; label: string; level: ColorLevel; unicode: boolean; width: number;
  face?: string | null; faceCol?: number | null;
}): string {
  const frames = opts.unicode ? SPINNER_FRAMES_UNICODE : SPINNER_FRAMES_ASCII;
  const frame = frames[opts.tick % frames.length];
  const secs = `${Math.floor(opts.elapsedMs / 1000)}s`;
  const plain = `${frame} ${opts.label} ${secs}`;
  const room = Math.max(1, opts.width - 1);
  if (textWidth(plain) > room) return truncateWidth(plain, room, opts.unicode ? "…" : "...");
  let line = paint(frame, opts.level, { fg: BRAND.sage, bold: true }) + " "
    + paint(opts.label, opts.level, { fg: BRAND.sage }) + " "
    + paint(secs, opts.level, { fg: BRAND.muted });
  if (opts.face && opts.faceCol !== null && opts.faceCol !== undefined) {
    const col = opts.faceCol;
    const faceW = textWidth(opts.face.replace(/\x1b\[[0-9;]*m/g, ""));
    if (col > textWidth(plain) + 1 && col + faceW <= opts.width) line += " ".repeat(col - textWidth(plain)) + opts.face;
  }
  return line;
}

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private shown = false;
  tick = 0;
  label: string;
  private o: SpinnerOpts;

  constructor(opts: SpinnerOpts) {
    this.o = opts;
    this.label = opts.label ?? "思考中…";
  }

  get running(): boolean { return this.timer !== null; }

  private now(): number { return (this.o.now ?? Date.now)(); }

  private draw(): void {
    const line = spinnerLine({
      tick: this.tick, elapsedMs: this.now() - this.startedAt, label: this.label,
      level: this.o.level ?? 0, unicode: this.o.unicode ?? true, width: this.o.width?.() ?? 80,
      face: this.o.face?.(this.tick) ?? null, faceCol: this.o.faceCol?.() ?? null,
    });
    this.o.write("\r\x1b[2K" + line);
    this.shown = true;
  }

  /** 开始转（非 TTY 时什么都不做）。 */
  start(label?: string): void {
    if (label) this.label = label;
    if (!this.o.tty) return;
    this.startedAt = this.now();
    this.tick = 0;
    this.resume();
  }

  /** 临时清掉 spinner 行（打印别的内容前调用）。 */
  pause(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.shown) { this.o.write("\r\x1b[2K"); this.shown = false; }
  }

  /** 从 pause 恢复（计时不归零）。 */
  resume(): void {
    if (!this.o.tty || this.timer) return;
    if (!this.startedAt) this.startedAt = this.now();
    this.draw();
    this.timer = setInterval(() => { this.tick++; this.draw(); }, this.o.intervalMs ?? 90);
    (this.timer as { unref?: () => void }).unref?.();
  }

  setLabel(label: string): void {
    this.label = label;
    if (this.timer) this.draw();
  }

  stop(): void {
    this.pause();
    this.startedAt = 0;
  }
}
