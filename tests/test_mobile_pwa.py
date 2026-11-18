"""Phone PWA: QR encoder, device pairing registry, /m page, splash rules."""

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import nyra.agent as agent_module  # noqa: E402
import nyra.config as config_module  # noqa: E402
import nyra.memory as memory_module  # noqa: E402
from nyra import qrcode as qr  # noqa: E402
from nyra import webui  # noqa: E402
from nyra.pairing import (  # noqa: E402
    DeviceRegistry, PairingError, hash_device_token,
)
from nyra.webui_mobile import (  # noqa: E402
    MOBILE_HTML, MOBILE_MANIFEST, SPLASH_BG, STARTUP_SIZES, solid_png,
)

ROOT = Path(__file__).resolve().parent.parent
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# ---------------------------------------------------------------------------
# An independent reader for the codes we generate: reads the format bits,
# unmasks, walks the zigzag, de-interleaves the blocks, checks every
# Reed-Solomon block has zero syndromes and parses the byte-mode payload.
# Used when no third-party decoder (zxing-cpp + Pillow) is installed.
# ---------------------------------------------------------------------------
def _gf_tables():
    exp = [0] * 512
    log = [0] * 256
    x = 1
    for i in range(255):
        exp[i] = x
        log[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        exp[i] = exp[i - 255]
    return exp, log


_EXP, _LOG = _gf_tables()


def _poly_eval(coeffs, x):
    y = 0
    for c in coeffs:
        y = (_EXP[_LOG[y] + _LOG[x]] if y and x else 0) ^ c
    return y


def selfcheck_decode(matrix):
    size = len(matrix)
    ver = (size - 17) // 4
    # format bits, first copy (around the top-left finder)
    coords = [(8, i) for i in range(6)] + [(8, 7), (8, 8), (7, 8)] + [(14 - i, 8) for i in range(9, 15)]
    bits = 0
    for i, (x, y) in enumerate(coords):
        if matrix[y][x]:
            bits |= 1 << i
    best = None
    for data in range(32):
        rem = data
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        cand = (data << 10 | rem) ^ 0x5412
        dist = bin(cand ^ bits).count("1")
        if best is None or dist < best[0]:
            best = (dist, data)
    assert best[0] == 0, "format bits do not match any valid BCH codeword"
    ecl = {1: "L", 0: "M", 3: "Q", 2: "H"}[best[1] >> 3]
    mask = best[1] & 7
    # function-module map from the encoder's own geometry helper
    fm = qr._Matrix(ver)
    fm.draw_function_patterns()
    masks = [
        lambda x, y: (x + y) % 2 == 0, lambda x, y: y % 2 == 0,
        lambda x, y: x % 3 == 0, lambda x, y: (x + y) % 3 == 0,
        lambda x, y: (x // 3 + y // 2) % 2 == 0, lambda x, y: x * y % 2 + x * y % 3 == 0,
        lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
        lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0,
    ]
    stream = []
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5
        for vert in range(size):
            for j in range(2):
                x = right - j
                upward = ((right + 1) & 2) == 0
                y = (size - 1 - vert) if upward else vert
                if not fm.isfunc[y][x]:
                    stream.append(matrix[y][x] ^ masks[mask](x, y))
        right -= 2
    raw = qr._num_raw_data_modules(ver) // 8
    codewords = [int("".join("1" if b else "0" for b in stream[i * 8:i * 8 + 8]), 2) for i in range(raw)]
    nblocks = qr._NUM_ERROR_CORRECTION_BLOCKS[ecl][ver]
    ecclen = qr._ECC_CODEWORDS_PER_BLOCK[ecl][ver]
    nshort = nblocks - raw % nblocks
    shortlen = raw // nblocks
    blocks = [[] for _ in range(nblocks)]
    k = 0
    for i in range(shortlen + 1):
        for j in range(nblocks):
            if i == shortlen - ecclen and j < nshort:
                continue  # short blocks have no byte here
            blocks[j].append(codewords[k])
            k += 1
    data = []
    for blk in blocks:
        for e in range(ecclen):
            assert _poly_eval(blk, _EXP[e]) == 0, "Reed-Solomon syndrome is not zero"
        data.extend(blk[:len(blk) - ecclen])
    bitstr = "".join(f"{b:08b}" for b in data)
    assert bitstr[:4] == "0100", "not byte mode"
    nbits = 8 if ver <= 9 else 16
    length = int(bitstr[4:4 + nbits], 2)
    start = 4 + nbits
    payload = bytes(int(bitstr[start + 8 * i:start + 8 * i + 8], 2) for i in range(length))
    return payload.decode("utf-8")


def decode(matrix):
    try:
        import zxingcpp  # test-only, optional
        from PIL import Image
    except ImportError:
        return selfcheck_decode(matrix)
    scale, border = 4, 4
    n = len(matrix)
    dim = (n + 2 * border) * scale
    img = Image.new("L", (dim, dim), 255)
    px = img.load()
    for y, row in enumerate(matrix):
        for x, dark in enumerate(row):
            if dark:
                for a in range(scale):
                    for b in range(scale):
                        px[(x + border) * scale + a, (y + border) * scale + b] = 0
    results = zxingcpp.read_barcodes(img)
    assert results, "zxing found no QR code"
    # Cross-check with the self-written reader as well.
    assert selfcheck_decode(matrix) == results[0].text
    return results[0].text


class QRCodeTests(unittest.TestCase):
    def test_pair_url_round_trips(self):
        url = "http://192.168.1.23:8765/m#pair=482913"
        self.assertEqual(decode(qr.encode(url)), url)

    def test_many_lengths_and_both_levels(self):
        for n in (1, 17, 41, 80, 150, 260, 400):
            text = "".join(chr(0x61 + (i * 7) % 26) for i in range(n))
            for ecl in ("L", "M"):
                with self.subTest(n=n, ecl=ecl):
                    self.assertEqual(decode(qr.encode(text, ecl)), text)

    def test_utf8(self):
        self.assertEqual(decode(qr.encode("连接 Nyra")), "连接 Nyra")

    def test_selfcheck_detects_corruption(self):
        m = qr.encode("http://10.0.0.2:8765/m#pair=123456")
        m[len(m) - 1][len(m) - 1] = not m[len(m) - 1][len(m) - 1]
        with self.assertRaises(AssertionError):
            selfcheck_decode(m)

    def test_svg_and_terminal(self):
        m = qr.encode("abc")
        svg = qr.to_svg(m, title="t")
        self.assertTrue(svg.startswith("<svg"))
        self.assertIn('viewBox="0 0 29 29"', svg)  # 21 modules + 2*4 quiet zone
        art = qr.to_terminal(m, ansi=False)
        self.assertEqual(len(art.splitlines()), (21 + 4 + 1) // 2)
        self.assertIn("\u2588", art)
        self.assertIn("\x1b[30;47m", qr.to_terminal(m, ansi=True))

    def test_too_long(self):
        with self.assertRaises(qr.QRError):
            qr.encode("x" * 5000)


# ---------------------------------------------------------------------------
class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class DeviceRegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "devices.json"
        self.clock = FakeClock()
        self.reg = DeviceRegistry(self.path, code_ttl=300, max_attempts=5, clock=self.clock)

    def tearDown(self):
        self.tmp.cleanup()

    def test_code_is_six_digits(self):
        info = self.reg.start_pairing()
        self.assertRegex(info["code"], r"^\d{6}$")
        self.assertEqual(info["expires_in"], 300)

    def test_no_active_code(self):
        with self.assertRaises(PairingError):
            self.reg.redeem("123456")

    def test_expiry(self):
        code = self.reg.start_pairing()["code"]
        self.clock.t += 301
        with self.assertRaisesRegex(PairingError, "过期"):
            self.reg.redeem(code)
        self.assertEqual(self.reg.list_devices(), [])

    def test_single_use(self):
        code = self.reg.start_pairing()["code"]
        self.reg.redeem(code, "Pixel")
        with self.assertRaises(PairingError):
            self.reg.redeem(code, "again")
        self.assertEqual(len(self.reg.list_devices()), 1)

    def test_attempt_limit(self):
        code = self.reg.start_pairing()["code"]
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(4):
            with self.assertRaisesRegex(PairingError, "配对码错误"):
                self.reg.redeem(wrong)
        with self.assertRaisesRegex(PairingError, "作废"):
            self.reg.redeem(wrong)
        with self.assertRaises(PairingError):  # even the right code is dead now
            self.reg.redeem(code)

    def test_new_code_invalidates_old(self):
        old = self.reg.start_pairing()["code"]
        new = self.reg.start_pairing()["code"]
        if old != new:
            with self.assertRaises(PairingError):
                self.reg.redeem(old)
        self.reg.redeem(new)

    def test_token_only_stored_as_hash(self):
        code = self.reg.start_pairing()["code"]
        dev = self.reg.redeem(code, "iPhone")
        raw = self.path.read_text(encoding="utf-8")
        self.assertNotIn(dev["token"], raw)
        self.assertIn(hash_device_token(dev["token"]), raw)
        self.assertGreaterEqual(len(dev["token"]), 40)
        listed = self.reg.list_devices()
        self.assertEqual(listed[0]["name"], "iPhone")
        self.assertNotIn("token_sha256", listed[0])
        self.assertNotIn("token", listed[0])
        if os.name == "posix":
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_authenticate_and_revoke(self):
        dev = self.reg.redeem(self.reg.start_pairing()["code"], "A")
        self.assertEqual(self.reg.authenticate(dev["token"])["id"], dev["id"])
        self.assertIsNone(self.reg.authenticate(dev["token"] + "x"))
        self.assertIsNone(self.reg.authenticate(""))
        self.assertTrue(self.reg.revoke(dev["id"]))
        self.assertFalse(self.reg.revoke(dev["id"]))
        self.assertIsNone(self.reg.authenticate(dev["token"]))

    def test_survives_restart_and_external_revoke(self):
        dev = self.reg.redeem(self.reg.start_pairing()["code"], "A")
        other = DeviceRegistry(self.path)
        self.assertIsNotNone(other.authenticate(dev["token"]))
        # revoke from another process (e.g. `python3 -m nyra.pairing revoke`)
        self.assertTrue(DeviceRegistry(self.path).revoke(dev["id"]))
        self.assertIsNone(self.reg.authenticate(dev["token"]))

    def test_name_is_cleaned(self):
        dev = self.reg.redeem(self.reg.start_pairing()["code"], "x\n\x00" + "y" * 100)
        self.assertNotIn("\n", dev["name"])
        self.assertLessEqual(len(dev["name"]), 40)


# ---------------------------------------------------------------------------
class MobilePageTests(unittest.TestCase):
    def test_splash_only_in_mobile_page(self):
        self.assertEqual(MOBILE_HTML.count('id="nyra-splash"'), 1)
        self.assertIn("NyraSplash", MOBILE_HTML)
        self.assertIn("prefers-reduced-motion", MOBILE_HTML)
        self.assertIn("display-mode: standalone", MOBILE_HTML)
        self.assertIn("navigator.standalone", MOBILE_HTML)
        self.assertIn("nyra-splash-seen", MOBILE_HTML)  # once per cold start
        self.assertNotIn("nyra-splash", webui.PAGE_HTML)  # desktop web UI: none
        docs = ROOT / "docs" / "index.html"
        if docs.exists():
            self.assertNotIn("nyra-splash", docs.read_text(encoding="utf-8"))  # site: none

    def test_zero_external_requests_and_no_video(self):
        self.assertNotRegex(MOBILE_HTML, r"<video|\.mp4|<script[^>]+src=|@import|https?://(?!www\.w3\.org)")
        self.assertNotIn("angel", MOBILE_HTML.lower())

    def test_startup_and_theme_match_first_frame(self):
        self.assertEqual(MOBILE_MANIFEST["background_color"], SPLASH_BG)
        self.assertEqual(MOBILE_MANIFEST["theme_color"], SPLASH_BG)
        self.assertEqual(MOBILE_MANIFEST["display"], "standalone")
        self.assertEqual(MOBILE_MANIFEST["start_url"], "/m")
        self.assertIn('<meta name="theme-color" content="#0B0B0C">', MOBILE_HTML)
        links = re.findall(r'apple-touch-startup-image" href="/m/startup/(\d+)x(\d+)\.png"', MOBILE_HTML)
        self.assertGreaterEqual(len(links), 10)
        for w, h in links:
            self.assertIn((int(w), int(h)), STARTUP_SIZES)
        png = solid_png(750, 1334)
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
        import struct
        import zlib
        idat = png[png.index(b"IDAT") + 4:png.index(b"IEND") - 8]
        raw = zlib.decompress(idat)
        self.assertEqual(raw[1:4], bytes.fromhex(SPLASH_BG[1:]))
        self.assertEqual(struct.unpack(">II", png[16:24]), (750, 1334))

    def test_splash_frame_zero_is_background_only(self):
        # The first animation frame is the flat background (disc scale 0),
        # so the solid startup image hands over without a visible jump.
        self.assertIn("eBack(P(t,0.12,0.62))", MOBILE_HTML)

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_splash_decision_rules(self):
        start = MOBILE_HTML.index("/*nyra-splash-decide:start*/")
        end = MOBILE_HTML.index("/*nyra-splash-decide:end*/")
        fn = MOBILE_HTML[start:end]
        phone = {"seen": False, "standalone": True, "iosStandalone": False, "coarse": True,
                 "shortSide": 390, "reducedMotion": False}
        cases = [
            (phone, "play"),
            (dict(phone, standalone=False, iosStandalone=True), "play"),   # iOS
            (dict(phone, reducedMotion=True), "static"),
            (dict(phone, seen=True), "none"),                              # already played
            (dict(phone, standalone=False), "none"),                       # browser tab
            (dict(phone, coarse=False, shortSide=1080), "none"),           # desktop PWA
            (dict(phone, coarse=False), "none"),
            (dict(phone, shortSide=1440), "none"),                         # big touch screen
        ]
        script = fn + "\nconst cases=" + json.dumps([c for c, _ in cases]) + \
            ";process.stdout.write(JSON.stringify(cases.map(nyraSplashMode)));"
        out = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), [want for _, want in cases])


# ---------------------------------------------------------------------------
class MobileServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        home = Path(self.tmp.name) / "home"
        self.workdir = Path(self.tmp.name) / "work"
        self.workdir.mkdir()
        self.patches = [
            mock.patch.object(config_module, "NYRA_HOME", home),
            mock.patch.object(agent_module, "NYRA_HOME", home),
            mock.patch.object(memory_module, "SESSIONS_DIR", home / "sessions"),
            mock.patch.object(memory_module, "MEMORY_PATH", home / "MEMORY.md"),
            mock.patch.object(memory_module, "GLOBAL_AGENTS_PATH", home / "AGENTS.md"),
        ]
        for p in self.patches:
            p.start()
        self.registry = DeviceRegistry(home / "devices.json")
        self.state = webui.UIState(self.workdir, devices=self.registry)
        self.server = webui.make_server("127.0.0.1", 0, self.state, warn_stream=io.StringIO())
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def req(self, path, method="GET", body=None, owner=False, device=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        r = urllib.request.Request(self.base + path, data=data, method=method)
        if owner:
            r.add_header("X-Nyra-Token", self.state.token)
        if device:
            r.add_header("X-Nyra-Device", device)
        if data is not None:
            r.add_header("Content-Type", "application/json")
        try:
            with _OPENER.open(r, timeout=10) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), dict(exc.headers)

    def test_loopback_only_cannot_pair(self):
        status, body, _ = self.req("/api/pair/start", "POST", {}, owner=True)
        self.assertEqual(status, 409)
        self.assertIn("--pair", json.loads(body)["error"])

    def test_public_shell_needs_no_token(self):
        status, body, headers = self.req("/m")
        self.assertEqual(status, 200)
        self.assertIn(b"nyra-splash", body)
        self.assertIn("default-src 'none'", headers["Content-Security-Policy"])
        self.assertEqual(headers["Content-Security-Policy"], webui.CSP)  # CSP not loosened
        status, body, _ = self.req("/m/manifest.json")
        self.assertEqual(json.loads(body)["start_url"], "/m")
        self.assertEqual(self.req("/m/icon-192.png")[0], 200)
        self.assertEqual(self.req("/m/startup/1170x2532.png")[0], 200)
        self.assertEqual(self.req("/m/startup/999x999.png")[0], 404)
        # the API itself is still closed
        self.assertEqual(self.req("/api/sessions")[0], 403)

    def test_full_pairing_flow(self):
        self.state.pair_origin = "http://192.168.1.50:8765"  # as if bound to the LAN
        status, body, _ = self.req("/api/pair/start", "POST", {}, owner=True)
        self.assertEqual(status, 200)
        info = json.loads(body)
        self.assertEqual(info["url"], f"http://192.168.1.50:8765/m#pair={info['code']}")
        self.assertTrue(info["svg"].startswith("<svg"))
        # wrong code
        wrong = "000000" if info["code"] != "000000" else "111111"
        self.assertEqual(self.req("/api/pair", "POST", {"code": wrong})[0], 401)
        # right code -> device token
        status, body, _ = self.req("/api/pair", "POST", {"code": info["code"], "name": "Pixel 7"})
        self.assertEqual(status, 200)
        dev = json.loads(body)
        # reused code fails
        self.assertEqual(self.req("/api/pair", "POST", {"code": info["code"]})[0], 401)
        # the phone can use the API
        status, body, _ = self.req("/api/sessions", device=dev["token"])
        self.assertEqual(status, 200)
        status, body, _ = self.req("/api/approvals", device=dev["token"])
        self.assertEqual(json.loads(body), {"approvals": []})
        self.assertEqual(self.req("/api/sessions", "POST", {}, device=dev["token"])[0], 201)
        # but cannot manage devices or start another pairing
        self.assertEqual(self.req("/api/devices", device=dev["token"])[0], 403)
        self.assertEqual(self.req("/api/pair/start", "POST", {}, device=dev["token"])[0], 403)
        self.assertEqual(self.req(f"/api/devices/{dev['id']}/revoke", "POST", {}, device=dev["token"])[0], 403)
        # the desktop sees and revokes it
        status, body, _ = self.req("/api/devices", owner=True)
        listed = json.loads(body)["devices"]
        self.assertEqual([d["name"] for d in listed], ["Pixel 7"])
        self.assertNotIn(dev["token"], body.decode("utf-8"))
        self.assertEqual(self.req(f"/api/devices/{dev['id']}/revoke", "POST", {}, owner=True)[0], 200)
        self.assertEqual(self.req("/api/sessions", device=dev["token"])[0], 401)
        self.assertEqual(self.req(f"/api/devices/{dev['id']}/revoke", "POST", {}, owner=True)[0], 404)

    def test_bad_device_token(self):
        self.assertEqual(self.req("/api/sessions", device="nope")[0], 401)

    def test_print_pairing(self):
        self.state.pair_origin = "http://192.168.1.50:8765"
        out = io.StringIO()
        self.assertTrue(webui.print_pairing(self.state, out))
        text = out.getvalue()
        self.assertIn("\u2588", text)
        self.assertRegex(text, r"配对码 \d{6}")
        self.assertIn("http://192.168.1.50:8765/m", text)
        out = io.StringIO()
        self.state.pair_origin = None
        self.assertFalse(webui.print_pairing(self.state, out))

    def test_pair_flag(self):
        args = webui.build_parser().parse_args(["--pair"])
        self.assertTrue(args.pair)
        self.assertEqual(args.host, "127.0.0.1")  # main() widens it only with --pair
        self.assertFalse(webui.build_parser().parse_args([]).pair)

    def test_lan_bind_sets_pair_origin(self):
        stream = io.StringIO()
        state = webui.UIState(self.workdir, devices=self.registry)
        with mock.patch.object(webui, "lan_ipv4_addresses", return_value=["192.168.7.9"]):
            server = webui.make_server("0.0.0.0", 0, state, warn_stream=stream)
        try:
            self.assertIn("警告", stream.getvalue())
            self.assertEqual(state.pair_origin, f"http://192.168.7.9:{server.server_address[1]}")
        finally:
            server.server_close()


if __name__ == "__main__":
    unittest.main()
