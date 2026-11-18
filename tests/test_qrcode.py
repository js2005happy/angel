"""Tests for nyra.qrcode (stdlib unittest only)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nyra.qrcode import encode, to_svg  # noqa: E402


class QrSvgTests(unittest.TestCase):
    def test_encode_returns_square_bool_matrix(self):
        matrix = encode("hello", "M")
        self.assertTrue(matrix)
        self.assertEqual(len(matrix), len(matrix[0]))
        self.assertTrue(all(isinstance(cell, bool) for row in matrix for cell in row))

    def test_svg_title_cannot_break_out_of_attribute(self):
        # title 只转义 & 和 < 时，title 里的引号能闭合 aria-label 属性，
        # 注入任意属性/事件处理器；现在 " 和 > 也必须转义。
        svg = to_svg([[True]], title='x" onload="alert(1)')
        self.assertNotIn('onload="alert(1)"', svg)
        self.assertNotIn('" onload=', svg)
        self.assertIn("&quot;", svg)


if __name__ == "__main__":
    unittest.main()
