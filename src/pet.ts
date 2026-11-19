// src/pet.ts — 终端小伙伴「小芽」：坐在输入区右侧的 Nyra 小角色（4 行 × 12 列）。
// 灵感来自"终端里陪你写代码的小宠物"这个点子，造型与台词全部原创：
// 圆角身体、头顶一颗珊瑚色小星芒（呼应品牌点缀色），鼠尾草绿描边。
//
// 表情随状态变化：idle（偶尔眨眼）/ thinking（眼珠随 spinner 转圈）/ happy /
// worried / approval（举手）。偶尔冒一句一行的小气泡，几秒后消失。
//
// 这里只有纯函数 + 一个可注入时钟/定时器的控制器；真正往终端画由 cli.ts 负责
// （保存/恢复光标、只画右侧固定列，不打扰 readline 的输入）。
import { BRAND, paint, type ColorLevel } from "./theme.ts";
import { textWidth } from "./consoleUi.ts";
import { t, tList } from "./i18n.ts";

export type PetState = "idle" | "blink" | "thinking" | "happy" | "worried" | "approval";

/** 小伙伴占的列宽（含左侧 1 列间隔）与行高。 */
export const PET_WIDTH = 12;
export const PET_HEIGHT = 4;
/** 小伙伴需要的最小终端宽度。 */
export const PET_MIN_COLS = 80;

const THINK_EYES = ["◜", "◝", "◞", "◟"];

interface Face { eyes: [string, string]; mouth: string; spark?: boolean; hand?: boolean; sweat?: boolean }

function faceFor(state: PetState, tick: number): Face {
  switch (state) {
    case "blink": return { eyes: ["─", "─"], mouth: "‿" };
    case "thinking": { const e = THINK_EYES[((tick % 4) + 4) % 4]; return { eyes: [e, e], mouth: "·" }; }
    case "happy": return { eyes: ["^", "^"], mouth: "◡", spark: true };
    case "worried": return { eyes: ["ó", "ò"], mouth: "~", sweat: true };
    case "approval": return { eyes: ["•", "•"], mouth: "o", hand: true };
    default: return { eyes: ["•", "•"], mouth: "‿" };
  }
}

type Seg = [string, "body" | "spark" | "eye" | "mouth" | "hand" | "plain"];

function rowsFor(state: PetState, tick: number): Seg[][] {
  const f = faceFor(state, tick);
  const lead: Seg = ["  ", "plain"];
  return [
    [lead, ["╭──", "body"], ["✦", "spark"], ["──╮", "body"], f.hand ? [" o", "hand"] : f.spark ? [" ✧", "spark"] : ["", "plain"]],
    [lead, ["│ ", "body"], [f.eyes[0], "eye"], [" ", "plain"], [f.eyes[1], "eye"], [" ", "plain"],
      f.hand ? ["├─╯", "body"] : ["│", "body"], f.sweat ? [" '", "hand"] : ["", "plain"]],
    [lead, ["│  ", "body"], [f.mouth, "mouth"], ["  │", "body"]],
    [lead, ["╰┬───┬╯", "body"]],
  ];
}

function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - textWidth(text)));
}

/** 纯文本帧：PET_HEIGHT 行，每行恰好 PET_WIDTH 列。 */
export function petFrame(state: PetState, tick = 0): string[] {
  return rowsFor(state, tick).map((row) => padRight(row.map((s) => s[0]).join(""), PET_WIDTH));
}

/** 上色后的帧（level 0 时与 petFrame 相同）。 */
export function renderPet(state: PetState, opts: { level: ColorLevel; tick?: number }): string[] {
  const colors: Record<Seg[1], { fg?: string; bold?: boolean }> = {
    body: { fg: BRAND.sage }, spark: { fg: BRAND.coral, bold: true }, eye: { fg: BRAND.text, bold: true },
    mouth: { fg: BRAND.coral }, hand: { fg: BRAND.mist, bold: true }, plain: {},
  };
  return rowsFor(state, opts.tick ?? 0).map((row) => {
    const plainWidth = textWidth(row.map((s) => s[0]).join(""));
    return row.map(([t, k]) => paint(t, opts.level, colors[k])).join("") + " ".repeat(Math.max(0, PET_WIDTH - plainWidth));
  });
}

/** spinner 行里的一行小脸，眼珠与 spinner 同步转。 */
export function petFace(state: PetState, tick = 0, level: ColorLevel = 0): string {
  const f = faceFor(state, tick);
  return paint("(", level, { fg: BRAND.sage }) + paint(f.eyes[0], level, { fg: BRAND.text, bold: true })
    + paint(f.mouth, level, { fg: BRAND.coral }) + paint(f.eyes[1], level, { fg: BRAND.text, bold: true })
    + paint(")", level, { fg: BRAND.sage });
}

/** 一行小气泡。 */
export function renderBubble(text: string, level: ColorLevel): string {
  if (!level) return `( ${text} )`;
  return paint("(", level, { fg: BRAND.sage }) + paint(` ${text} `, level, { fg: BRAND.text, italic: true })
    + paint(")", level, { fg: BRAND.sage });
}

export const IDLE_QUIPS = [
  "先读再改，稳。",
  "我在，慢慢来。",
  "/context 看看余量？",
  "改坏了还有 /undo",
  "喝口水再继续？",
  "小步提交，心里不慌。",
  "/mode readonly 更安心",
];
export const HAPPY_QUIPS = ["搞定！", "漂亮。", "这一步走得好。"];
export const WORRIED_QUIPS = ["别急，看看报错。", "换个思路试试？"];
export const APPROVAL_QUIP = "这步要你点个头。";

/** 当前界面语言的台词（上面的常量是中文版，保留给旧引用）。 */
export function idleQuips(): string[] { return tList("pet.idle"); }
export function happyQuips(): string[] { return tList("pet.happy"); }
export function worriedQuips(): string[] { return tList("pet.worried"); }
export function approvalQuip(): string { return t("pet.approval"); }

type Env = Record<string, string | undefined>;

/**
 * 小伙伴是否显示：配置 pet 默认 true；非 TTY、宽度 < 80、ASCII 回退（NYRA_ASCII
 * 或终端画不了框线）、CI 环境一律隐藏。
 */
export function petVisible(opts: { enabled: boolean; tty: boolean; cols: number; unicode: boolean; env?: Env }): boolean {
  const env = opts.env ?? process.env;
  if (!opts.enabled || !opts.tty || !opts.unicode) return false;
  if (opts.cols < PET_MIN_COLS) return false;
  const flag = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  if (flag(env.NYRA_ASCII)) return false;
  if (flag(env.CI) || env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE || env.JENKINS_URL || env.TF_BUILD) return false;
  return true;
}

/** 配置里的 pet 开关（缺省 = 开）。 */
export function petEnabledFromConfig(config: Record<string, unknown>): boolean {
  return config.pet !== false;
}

/** 解析 /pet 命令：返回新的开关值；null = 用法错误。 */
export function parsePetCommand(text: string, current: boolean): boolean | null {
  const arg = text.trim().split(/\s+/)[1]?.toLowerCase();
  if (arg === undefined) return !current;
  if (["on", "开", "1", "true"].includes(arg)) return true;
  if (["off", "关", "0", "false"].includes(arg)) return false;
  return null;
}

export interface PetClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  random: () => number;
}

const realClock: PetClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: Math.random,
};

/**
 * 状态机 + 定时器：眨眼、情绪回落、偶尔的气泡。每次外观变化调用 onChange()，
 * 由调用方决定怎么画（只在输入区可见时画）。所有定时器都 unref，不拖住进程退出。
 */
export class PetController {
  state: PetState = "idle";
  bubble: string | null = null;
  private mood: PetState = "idle";
  private timers = new Set<unknown>();
  private running = false;
  private lastQuipAt: number;
  private clock: PetClock;
  /** 两次闲聊气泡的最短间隔（毫秒）。 */
  quipCooldownMs = 150_000;
  bubbleMs = 5_000;

  constructor(private onChange: () => void, clock: Partial<PetClock> = {}) {
    this.clock = { ...realClock, ...clock };
    // 刚启动的 60 秒内不闲聊。
    this.lastQuipAt = this.clock.now() - this.quipCooldownMs + 60_000;
  }

  private later(fn: () => void, ms: number): void {
    const h = this.clock.setTimeout(() => { this.timers.delete(h); fn(); }, ms);
    this.timers.add(h);
  }

  /** 输入区出现时开始动（眨眼与闲聊）。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleBlink();
    this.scheduleIdleQuip();
  }

  /** 输入区消失时停下所有定时器（不再触发 onChange）。 */
  stop(): void {
    this.running = false;
    for (const h of this.timers) this.clock.clearTimeout(h);
    this.timers.clear();
    this.bubble = null;
    if (this.state === "blink") this.state = this.mood;
  }

  private scheduleBlink(): void {
    this.later(() => {
      if (!this.running) return;
      if (this.state === "idle") {
        this.state = "blink";
        this.onChange();
        this.later(() => { if (this.state === "blink") { this.state = this.mood; if (this.running) this.onChange(); } }, 160);
      }
      this.scheduleBlink();
    }, 3_000 + Math.floor(this.clock.random() * 4_000));
  }

  private scheduleIdleQuip(): void {
    this.later(() => {
      if (!this.running) return;
      if (this.state === "idle" && this.clock.random() < 0.5) {
        const quips = idleQuips();
        this.say(quips[Math.floor(this.clock.random() * quips.length)]);
      }
      this.scheduleIdleQuip();
    }, 45_000);
  }

  /** 冒一句气泡（受冷却限制；force 用于审批这类必须提示的场合）。 */
  say(text: string, force = false): boolean {
    const now = this.clock.now();
    if (!force && now - this.lastQuipAt < this.quipCooldownMs) return false;
    this.lastQuipAt = now;
    this.bubble = text;
    if (this.running) this.onChange();
    this.later(() => { if (this.bubble === text) { this.bubble = null; if (this.running) this.onChange(); } }, this.bubbleMs);
    return true;
  }

  /** 设置情绪：happy / worried 几秒后回到 idle；thinking / approval 保持到下一次设置。 */
  setMood(mood: Exclude<PetState, "blink">): void {
    this.mood = mood;
    this.state = mood;
    if (mood === "happy" && this.clock.random() < 0.3) { const q = happyQuips(); this.say(q[Math.floor(this.clock.random() * q.length)]); }
    if (mood === "worried") { const q = worriedQuips(); this.say(q[Math.floor(this.clock.random() * q.length)]); }
    if (mood === "approval") this.say(approvalQuip(), true);
    if (mood === "happy" || mood === "worried") {
      this.later(() => {
        if (this.mood === mood) { this.mood = "idle"; this.state = "idle"; if (this.running) this.onChange(); }
      }, mood === "happy" ? 4_000 : 6_000);
    }
    if (this.running) this.onChange();
  }
}
