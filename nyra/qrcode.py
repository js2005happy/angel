"""Tiny QR Code encoder (byte mode, error-correction level L or M).

Written for Nyra's phone pairing so the QR code is generated locally,
with no third-party service and no new dependency. Pure standard library.

The algorithm follows the QR Code specification (ISO/IEC 18004): byte-mode
segment, Reed-Solomon error correction over GF(256) (polynomial 0x11D),
block interleaving, function patterns, the eight data masks with the
standard penalty rules, and BCH-coded format/version information. The code
structure (table layout and helper names) is modelled on Project Nayuki's
"QR Code generator library" (MIT License, https://www.nayuki.io/page/
qr-code-generator-library); this file is an independent, reduced rewrite
(byte mode, levels L/M only) and is distributed under this repository's
licence.

Outputs:
- ``encode(text)`` -> list of rows of bools (True = dark module).
- ``to_svg(matrix)`` -> a standalone SVG string (one ``<path>``).
- ``to_terminal(matrix)`` -> Unicode half-block art for a terminal.
"""

from __future__ import annotations

__all__ = ["QRError", "encode", "to_svg", "to_terminal"]


class QRError(ValueError):
    pass


# Index 0 unused so the tables can be indexed by version (1..40).
_ECC_CODEWORDS_PER_BLOCK = {
    "L": (-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
          28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    "M": (-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
          26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28),
}
_NUM_ERROR_CORRECTION_BLOCKS = {
    "L": (-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
          8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25),
    "M": (-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
          17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49),
}
_FORMAT_BITS = {"L": 1, "M": 0}
_MAX_VERSION = 40


def _num_raw_data_modules(ver: int) -> int:
    result = (16 * ver + 128) * ver + 64
    if ver >= 2:
        numalign = ver // 7 + 2
        result -= (25 * numalign - 10) * numalign - 55
        if ver >= 7:
            result -= 36
    return result


def _num_data_codewords(ver: int, ecl: str) -> int:
    return (
        _num_raw_data_modules(ver) // 8
        - _ECC_CODEWORDS_PER_BLOCK[ecl][ver] * _NUM_ERROR_CORRECTION_BLOCKS[ecl][ver]
    )


# -- Reed-Solomon over GF(2^8) ------------------------------------------------
def _gf_mul(x: int, y: int) -> int:
    z = 0
    for i in reversed(range(8)):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _rs_divisor(degree: int) -> list[int]:
    result = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            result[j] = _gf_mul(result[j], root)
            if j + 1 < degree:
                result[j] ^= result[j + 1]
        root = _gf_mul(root, 0x02)
    return result


def _rs_remainder(data: list[int], divisor: list[int]) -> list[int]:
    result = [0] * len(divisor)
    for b in data:
        factor = b ^ result.pop(0)
        result.append(0)
        for i, coef in enumerate(divisor):
            result[i] ^= _gf_mul(coef, factor)
    return result


def _add_ecc_and_interleave(data: list[int], ver: int, ecl: str) -> list[int]:
    numblocks = _NUM_ERROR_CORRECTION_BLOCKS[ecl][ver]
    blockecclen = _ECC_CODEWORDS_PER_BLOCK[ecl][ver]
    rawcodewords = _num_raw_data_modules(ver) // 8
    numshortblocks = numblocks - rawcodewords % numblocks
    shortblocklen = rawcodewords // numblocks
    divisor = _rs_divisor(blockecclen)
    blocks = []
    k = 0
    for i in range(numblocks):
        datlen = shortblocklen - blockecclen + (0 if i < numshortblocks else 1)
        dat = list(data[k:k + datlen])
        k += datlen
        ecc = _rs_remainder(dat, divisor)
        if i < numshortblocks:
            dat.append(0)  # placeholder, skipped when interleaving
        blocks.append(dat + ecc)
    result = []
    for i in range(len(blocks[0])):
        for j, blk in enumerate(blocks):
            if i != shortblocklen - blockecclen or j >= numshortblocks:
                result.append(blk[i])
    return result


# -- matrix --------------------------------------------------------------------
class _Matrix:
    def __init__(self, ver: int) -> None:
        self.ver = ver
        self.size = ver * 4 + 17
        self.modules = [[False] * self.size for _ in range(self.size)]
        self.isfunc = [[False] * self.size for _ in range(self.size)]

    def set_func(self, x: int, y: int, dark: bool) -> None:
        self.modules[y][x] = dark
        self.isfunc[y][x] = True

    def alignment_positions(self) -> list[int]:
        if self.ver == 1:
            return []
        numalign = self.ver // 7 + 2
        step = (self.ver * 8 + numalign * 3 + 5) // (numalign * 4 - 4) * 2
        result = [self.size - 7 - i * step for i in range(numalign - 1)] + [6]
        return list(reversed(result))

    def draw_function_patterns(self) -> None:
        size = self.size
        for i in range(size):
            self.set_func(6, i, i % 2 == 0)
            self.set_func(i, 6, i % 2 == 0)
        for (cx, cy) in ((3, 3), (size - 4, 3), (3, size - 4)):
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    x, y = cx + dx, cy + dy
                    if 0 <= x < size and 0 <= y < size:
                        self.set_func(x, y, max(abs(dx), abs(dy)) not in (2, 4))
        pos = self.alignment_positions()
        n = len(pos)
        for i in range(n):
            for j in range(n):
                if (i == 0 and j == 0) or (i == 0 and j == n - 1) or (i == n - 1 and j == 0):
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        self.set_func(pos[i] + dx, pos[j] + dy, max(abs(dx), abs(dy)) != 1)
        self.draw_format_bits("M", 0)  # reserve; redrawn after masking
        self.draw_version()

    def draw_format_bits(self, ecl: str, mask: int) -> None:
        data = _FORMAT_BITS[ecl] << 3 | mask
        rem = data
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        bits = (data << 10 | rem) ^ 0x5412
        bit = lambda i: ((bits >> i) & 1) != 0  # noqa: E731
        size = self.size
        for i in range(0, 6):
            self.set_func(8, i, bit(i))
        self.set_func(8, 7, bit(6))
        self.set_func(8, 8, bit(7))
        self.set_func(7, 8, bit(8))
        for i in range(9, 15):
            self.set_func(14 - i, 8, bit(i))
        for i in range(0, 8):
            self.set_func(size - 1 - i, 8, bit(i))
        for i in range(8, 15):
            self.set_func(8, size - 15 + i, bit(i))
        self.set_func(8, size - 8, True)  # always-dark module

    def draw_version(self) -> None:
        if self.ver < 7:
            return
        rem = self.ver
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        bits = self.ver << 12 | rem
        for i in range(18):
            dark = ((bits >> i) & 1) != 0
            a = self.size - 11 + i % 3
            b = i // 3
            self.set_func(a, b, dark)
            self.set_func(b, a, dark)

    def draw_codewords(self, data: list[int]) -> None:
        size = self.size
        i = 0
        total = len(data) * 8
        right = size - 1
        while right >= 1:
            if right == 6:
                right = 5
            for vert in range(size):
                for j in range(2):
                    x = right - j
                    upward = ((right + 1) & 2) == 0
                    y = (size - 1 - vert) if upward else vert
                    if not self.isfunc[y][x] and i < total:
                        self.modules[y][x] = ((data[i >> 3] >> (7 - (i & 7))) & 1) != 0
                        i += 1
            right -= 2

    def apply_mask(self, mask: int) -> None:
        for y in range(self.size):
            for x in range(self.size):
                if self.isfunc[y][x]:
                    continue
                if mask == 0:
                    inv = (x + y) % 2 == 0
                elif mask == 1:
                    inv = y % 2 == 0
                elif mask == 2:
                    inv = x % 3 == 0
                elif mask == 3:
                    inv = (x + y) % 3 == 0
                elif mask == 4:
                    inv = (x // 3 + y // 2) % 2 == 0
                elif mask == 5:
                    inv = x * y % 2 + x * y % 3 == 0
                elif mask == 6:
                    inv = (x * y % 2 + x * y % 3) % 2 == 0
                else:
                    inv = ((x + y) % 2 + x * y % 3) % 2 == 0
                if inv:
                    self.modules[y][x] = not self.modules[y][x]

    def penalty(self) -> int:
        size = self.size
        m = self.modules
        score = 0
        lines = [m[y] for y in range(size)] + [[m[y][x] for y in range(size)] for x in range(size)]
        finder_a = [True, False, True, True, True, False, True, False, False, False, False]
        finder_b = finder_a[::-1]
        for line in lines:
            run = 1
            for i in range(1, size + 1):
                if i < size and line[i] == line[i - 1]:
                    run += 1
                else:
                    if run >= 5:
                        score += 3 + (run - 5)
                    run = 1
            padded = [False] * 4 + list(line) + [False] * 4
            for i in range(len(padded) - 10):
                window = padded[i:i + 11]
                if window == finder_a or window == finder_b:
                    score += 40
        for y in range(size - 1):
            for x in range(size - 1):
                c = m[y][x]
                if c == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                    score += 3
        dark = sum(sum(1 for v in row if v) for row in m)
        total = size * size
        k = (abs(dark * 20 - total * 10) + total - 1) // total - 1
        score += max(0, k) * 10
        return score


def _encode_data(payload: bytes, ver: int, ecl: str) -> list[int]:
    bits: list[int] = []

    def put(val: int, n: int) -> None:
        for i in reversed(range(n)):
            bits.append((val >> i) & 1)

    put(0b0100, 4)  # byte mode
    put(len(payload), 8 if ver <= 9 else 16)
    for b in payload:
        put(b, 8)
    capacity = _num_data_codewords(ver, ecl) * 8
    put(0, min(4, capacity - len(bits)))
    put(0, (-len(bits)) % 8)
    pad = 0xEC
    while len(bits) < capacity:
        put(pad, 8)
        pad ^= 0xEC ^ 0x11
    return [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]


def encode(text: str | bytes, ecl: str = "M") -> list[list[bool]]:
    """Encode ``text`` (UTF-8) as a QR Code; returns rows of booleans."""
    if ecl not in _FORMAT_BITS:
        raise QRError("error-correction level must be 'L' or 'M'")
    payload = text.encode("utf-8") if isinstance(text, str) else bytes(text)
    for ver in range(1, _MAX_VERSION + 1):
        count_bits = 8 if ver <= 9 else 16
        if 4 + count_bits + 8 * len(payload) <= _num_data_codewords(ver, ecl) * 8:
            break
    else:
        raise QRError("data too long for a QR Code")
    codewords = _add_ecc_and_interleave(_encode_data(payload, ver, ecl), ver, ecl)
    best = None
    best_score = None
    for mask in range(8):
        mtx = _Matrix(ver)
        mtx.draw_function_patterns()
        mtx.draw_codewords(codewords)
        mtx.apply_mask(mask)
        mtx.draw_format_bits(ecl, mask)
        score = mtx.penalty()
        if best_score is None or score < best_score:
            best, best_score = mtx, score
    assert best is not None
    return [list(row) for row in best.modules]


def to_svg(matrix: list[list[bool]], border: int = 4, dark: str = "#0B0B0C",
           light: str = "#FFFFFF", title: str = "QR") -> str:
    """Render as a small standalone SVG (scales cleanly; crispEdges)."""
    size = len(matrix)
    dim = size + border * 2
    parts = []
    for y, row in enumerate(matrix):
        x = 0
        while x < size:
            if row[x]:
                start = x
                while x < size and row[x]:
                    x += 1
                parts.append(f"M{start + border} {y + border}h{x - start}v1h-{x - start}z")
            else:
                x += 1
    esc = (
        title.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {dim} {dim}" '
        f'shape-rendering="crispEdges" role="img" aria-label="{esc}">'
        f'<rect width="{dim}" height="{dim}" fill="{light}"/>'
        f'<path fill="{dark}" d="{"".join(parts)}"/></svg>'
    )


_HALF = {(True, True): "\u2588", (True, False): "\u2580",
         (False, True): "\u2584", (False, False): " "}


def to_terminal(matrix: list[list[bool]], border: int = 2, ansi: bool = True) -> str:
    """Unicode half-block art: two module rows per text line.

    With ``ansi`` the code is drawn black-on-white explicitly, so it scans on
    dark and light terminal themes alike. Without it, dark modules are
    drawn as full blocks (works on light-on-dark terminals when scanning
    an inverted code is supported, and in plain-text logs).
    """
    size = len(matrix)
    dim = size + border * 2

    def dark(x: int, y: int) -> bool:
        x -= border
        y -= border
        return 0 <= x < size and 0 <= y < size and matrix[y][x]

    lines = []
    for y in range(0, dim, 2):
        chars = []
        for x in range(dim):
            top = dark(x, y)
            bot = dark(x, y + 1) if y + 1 < dim else False
            # Glyphs paint the dark modules; with ansi they are black on a
            # forced white background.
            chars.append(_HALF[(top, bot)])
        line = "".join(chars)
        if ansi:
            line = "\x1b[30;47m" + line + "\x1b[0m"
        lines.append(line)
    return "\n".join(lines)
