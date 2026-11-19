// src/qrcode.ts — 极小的 QR 码编码器（字节模式，纠错级别 L / M）。
//
// 给手机配对用：二维码在本机生成，不调第三方服务、不加依赖。与 Python 版
// nyra/qrcode.py（commit 134805e）同算法、同输出（逐模块一致，测试锁定）：
// 字节模式段、GF(256) 上的 Reed-Solomon（多项式 0x11D）、分块交织、功能图形、
// 8 种掩码 + 标准罚分、BCH 编码的格式/版本信息。表格布局与函数命名参考
// Project Nayuki 的 “QR Code generator library”（MIT License，
// https://www.nayuki.io/page/qr-code-generator-library）；本文件是独立的精简重写。
//
// 输出：encode(text) → 布尔矩阵（true = 深色模块）；toSvg(matrix) → 独立 SVG；
// toTerminal(matrix) → 终端用的 Unicode 半格字符画。

export class QRError extends Error {
  constructor(message: string) { super(message); this.name = "QRError"; }
}

export type ECL = "L" | "M";

// 下标 0 不用，按版本号 1..40 取。
const ECC_CODEWORDS_PER_BLOCK: Record<ECL, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
    28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
    26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const NUM_ERROR_CORRECTION_BLOCKS: Record<ECL, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
    8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};
const FORMAT_BITS: Record<ECL, number> = { L: 1, M: 0 };
const MAX_VERSION = 40;

function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(ver: number, ecl: ECL): number {
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
}

// ---- GF(2^8) 上的 Reed-Solomon ----
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff;
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function addEccAndInterleave(data: number[], ver: number, ecl: ECL): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0); // 占位，交织时跳过
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((blk, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blk[i]);
    });
  }
  return result;
}

// ---- 矩阵 ----
class Matrix {
  ver: number;
  size: number;
  modules: boolean[][];
  isFunc: boolean[][];

  constructor(ver: number) {
    this.ver = ver;
    this.size = ver * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunc = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFunc(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunc[y][x] = true;
  }

  alignmentPositions(): number[] {
    if (this.ver === 1) return [];
    const numAlign = Math.floor(this.ver / 7) + 2;
    const step = Math.floor((this.ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result: number[] = [];
    for (let i = 0; i < numAlign - 1; i++) result.push(this.size - 7 - i * step);
    result.push(6);
    return result.reverse();
  }

  drawFunctionPatterns(): void {
    const size = this.size;
    for (let i = 0; i < size; i++) {
      this.setFunc(6, i, i % 2 === 0);
      this.setFunc(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < size && y >= 0 && y < size) this.setFunc(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = this.alignmentPositions();
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            this.setFunc(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
    this.drawFormatBits("M", 0); // 先占位，掩码后重画
    this.drawVersion();
  }

  drawFormatBits(ecl: ECL, mask: number): void {
    const data = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    const size = this.size;
    for (let i = 0; i < 6; i++) this.setFunc(8, i, bit(i));
    this.setFunc(8, 7, bit(6));
    this.setFunc(8, 8, bit(7));
    this.setFunc(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunc(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunc(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunc(8, size - 15 + i, bit(i));
    this.setFunc(8, size - 8, true); // 恒深模块
  }

  drawVersion(): void {
    if (this.ver < 7) return;
    let rem = this.ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunc(a, b, dark);
      this.setFunc(b, a, dark);
    }
  }

  drawCodewords(data: number[]): void {
    const size = this.size;
    let i = 0;
    const total = data.length * 8;
    let right = size - 1;
    while (right >= 1) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunc[y][x] && i < total) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
      right -= 2;
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunc[y][x]) continue;
        let inv: boolean;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (inv) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  penalty(): number {
    const size = this.size;
    const m = this.modules;
    let score = 0;
    const lines: boolean[][] = [];
    for (let y = 0; y < size; y++) lines.push(m[y]);
    for (let x = 0; x < size; x++) lines.push(m.map((row) => row[x]));
    const finderA = [true, false, true, true, true, false, true, false, false, false, false];
    const finderB = [...finderA].reverse();
    const eq = (a: boolean[], b: boolean[], off: number): boolean => b.every((v, i) => a[off + i] === v);
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && line[i] === line[i - 1]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      const padded = [false, false, false, false, ...line, false, false, false, false];
      for (let i = 0; i < padded.length - 10; i++) {
        if (eq(padded, finderA, i) || eq(padded, finderB, i)) score += 40;
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    const total = size * size;
    // Python 的 // 是向下取整；这里分子恒为正，Math.floor 等价。
    const k = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1;
    score += Math.max(0, k) * 10;
    return score;
  }
}

function encodeData(payload: Uint8Array, ver: number, ecl: ECL): number[] {
  const bits: number[] = [];
  const put = (val: number, n: number): void => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4); // 字节模式
  put(payload.length, ver <= 9 ? 8 : 16);
  for (const b of payload) put(b, 8);
  const capacity = numDataCodewords(ver, ecl) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  let pad = 0xec;
  while (bits.length < capacity) {
    put(pad, 8);
    pad ^= 0xec ^ 0x11;
  }
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  return out;
}

/** 把 text（UTF-8）编成 QR 码；返回按行的布尔矩阵。 */
export function encode(text: string | Uint8Array, ecl: ECL = "M"): boolean[][] {
  if (ecl !== "L" && ecl !== "M") throw new QRError("纠错级别只能是 L 或 M");
  const payload = typeof text === "string" ? new TextEncoder().encode(text) : text;
  let ver = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + 8 * payload.length <= numDataCodewords(v, ecl) * 8) { ver = v; break; }
  }
  if (ver === 0) throw new QRError("内容太长，放不进二维码");
  const codewords = addEccAndInterleave(encodeData(payload, ver, ecl), ver, ecl);
  let best: Matrix | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const mtx = new Matrix(ver);
    mtx.drawFunctionPatterns();
    mtx.drawCodewords(codewords);
    mtx.applyMask(mask);
    mtx.drawFormatBits(ecl, mask);
    const score = mtx.penalty();
    if (score < bestScore) { best = mtx; bestScore = score; }
  }
  return best!.modules.map((row) => [...row]);
}

/** 渲染成小巧的独立 SVG（可无损缩放，crispEdges）。 */
export function toSvg(matrix: boolean[][], opts?: { border?: number; dark?: string; light?: string; title?: string }): string {
  const border = opts?.border ?? 4;
  const dark = opts?.dark ?? "#0B0B0C";
  const light = opts?.light ?? "#FFFFFF";
  const title = (opts?.title ?? "QR").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const size = matrix.length;
  const dim = size + border * 2;
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (row[x]) {
        const start = x;
        while (x < size && row[x]) x++;
        parts.push(`M${start + border} ${y + border}h${x - start}v1h-${x - start}z`);
      } else x++;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="${title}">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/><path fill="${dark}" d="${parts.join("")}"/></svg>`;
}

const HALF: Record<string, string> = { "11": "\u2588", "10": "\u2580", "01": "\u2584", "00": " " };

/**
 * 终端字符画：每行文字画两行模块。ansi=true 时强制黑字白底，深色/浅色主题都扫得出；
 * ansi=false 用于纯文本日志。
 */
export function toTerminal(matrix: boolean[][], opts?: { border?: number; ansi?: boolean }): string {
  const border = opts?.border ?? 2;
  const ansi = opts?.ansi ?? true;
  const size = matrix.length;
  const dim = size + border * 2;
  const dark = (x: number, y: number): boolean => {
    const xx = x - border;
    const yy = y - border;
    return xx >= 0 && xx < size && yy >= 0 && yy < size && matrix[yy][xx];
  };
  const lines: string[] = [];
  for (let y = 0; y < dim; y += 2) {
    let line = "";
    for (let x = 0; x < dim; x++) {
      const top = dark(x, y);
      const bot = y + 1 < dim ? dark(x, y + 1) : false;
      line += HALF[`${top ? 1 : 0}${bot ? 1 : 0}`];
    }
    lines.push(ansi ? `\x1b[30;47m${line}\x1b[0m` : line);
  }
  return lines.join("\n");
}
