"""Unexecuted regression cases for offline receipt verification."""
import hashlib
import hmac
import json
import unittest

from angel.acceptance_receipt import ReceiptError, verify_receipt


class ReceiptVerificationTests(unittest.TestCase):
    def setUp(self):
        self.key = b"k" * 32
        self.receipt = {
            "requirement": "checkout",
            "reference": "ci:42",
            "revision": "abc123",
            "environment": "staging",
        }
        payload = json.dumps(self.receipt, sort_keys=True, separators=(",", ":"),
                             ensure_ascii=False).encode("utf-8")
        self.receipt["mac"] = hmac.new(
            self.key, b"angel-acceptance-v1\x00" + payload, hashlib.sha256
        ).hexdigest()

    def verify(self, receipt=None, **kwargs):
        return verify_receipt(
            self.receipt if receipt is None else receipt,
            secret=kwargs.get("secret", self.key),
            expected_requirement=kwargs.get("requirement", "checkout"),
            expected_revision=kwargs.get("revision", "abc123"),
            expected_environment=kwargs.get("environment", "staging"),
            expected_reference=kwargs.get("reference"),
        )

    def test_exact_context(self):
        self.assertTrue(self.verify())

    def test_wrong_environment(self):
        self.assertFalse(self.verify(environment="production"))

    def test_wrong_requirement(self):
        self.assertFalse(self.verify(requirement="refund"))

    def test_tampered_receipt(self):
        self.assertFalse(self.verify({**self.receipt, "reference": "ci:43"}))

    def test_expected_reference_matches(self):
        self.assertTrue(self.verify(reference="ci:42"))

    def test_expected_reference_mismatch(self):
        self.assertFalse(self.verify(reference="ci:43"))

    def test_invalid_expected_reference(self):
        with self.assertRaises(ReceiptError):
            self.verify(reference=" ")

    def test_wrong_key(self):
        self.assertFalse(self.verify(secret=b"x" * 32))

    def test_weak_key_rejected(self):
        with self.assertRaises(ReceiptError):
            self.verify(secret=b"short")

    def test_unknown_field_rejected(self):
        with self.assertRaises(ReceiptError):
            self.verify({**self.receipt, "status": "passed"})

    def test_invalid_mac_rejected(self):
        with self.assertRaises(ReceiptError):
            self.verify({**self.receipt, "mac": "not-hex"})


if __name__ == "__main__":
    unittest.main()
