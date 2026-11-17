import unittest
import urllib.request

from nyra import net


class SchemeTests(unittest.TestCase):
    def test_rejects_non_http(self):
        for url in ("file:///etc/passwd", "ftp://x/y", "data:text/plain,hi"):
            with self.assertRaises(ValueError):
                net.open_url(urllib.request.Request(url), 1)


if __name__ == "__main__":
    unittest.main()
