"""Static-only regression definitions; not executed in this change."""
import hashlib
import hmac
import json
import unittest

from angel.acceptance_issuer import verify_issuer_receipt
from angel.acceptance_receipt import ReceiptError


class IssuerReceiptTests(unittest.TestCase):
    def setUp(self):
        self.key = b"z" * 32
        self.data = dict(requirement="checkout", reference="ci:42",
                         revision="abc123", environment="staging",
                         issuer="trusted-ci", key_id="2026-11")
        self.registry = {("trusted-ci", "2026-11"): self.key}
        payload = json.dumps(self.data, sort_keys=True, separators=(",", ":"),
                             ensure_ascii=False).encode("utf-8")
        self.data["mac"] = hmac.new(
            self.key, b"angel-acceptance-issuer-v2\x00" + payload,
            hashlib.sha256).hexdigest()

    def verify(self, receipt=None, registry=None, **kwargs):
        return verify_issuer_receipt(
            self.data if receipt is None else receipt,
            trusted_keys=self.registry if registry is None else registry,
            expected_issuer=kwargs.get("issuer", "trusted-ci"),
            expected_requirement=kwargs.get("requirement", "checkout"),
            expected_reference=kwargs.get("reference", "ci:42"),
            expected_revision=kwargs.get("revision", "abc123"),
            expected_environment=kwargs.get("environment", "staging"))

    def test_exact_issuer_and_context(self):
        self.assertTrue(self.verify())

    def test_unknown_or_retired_key(self):
        self.assertFalse(self.verify(registry={}))
        self.assertFalse(self.verify({**self.data, "key_id": "retired"}))

    def test_wrong_issuer(self):
        self.assertFalse(self.verify(issuer="another-ci"))

    def test_tampered_context(self):
        self.assertFalse(self.verify({**self.data, "revision": "different"}))

    def test_wrong_reference(self):
        self.assertFalse(self.verify(reference="ci:43"))

    def test_wrong_key_material(self):
        self.assertFalse(self.verify(registry={("trusted-ci", "2026-11"): b"x" * 32}))

    def test_invalid_key_id(self):
        with self.assertRaises(ReceiptError):
            self.verify({**self.data, "key_id": "../bad"})

    def test_weak_registry_key(self):
        with self.assertRaises(ReceiptError):
            self.verify(registry={("trusted-ci", "2026-11"): b"short"})

    def test_old_unsigned_receipt_schema_rejected(self):
        with self.assertRaises(ReceiptError):
            self.verify({k: v for k, v in self.data.items() if k != "issuer"})


if __name__ == "__main__":
    unittest.main()
