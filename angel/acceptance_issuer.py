"""Offline issuer-bound receipt verification; no key discovery or network access.

The trusted key registry MUST be provisioned outside the agent/model boundary.
A matching signature authenticates an issuer statement, not test execution.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Mapping

from .acceptance_receipt import ReceiptError

_CONTEXT = ("requirement", "reference", "revision", "environment")
_FIELDS = (*_CONTEXT, "issuer", "key_id")


def verify_issuer_receipt(
    receipt: Mapping[str, object],
    *,
    trusted_keys: Mapping[tuple[str, str], bytes],
    expected_issuer: str,
    expected_requirement: str,
    expected_reference: str,
    expected_revision: str,
    expected_environment: str,
) -> bool:
    """Fail closed unless a pinned issuer/key and all context fields match.

    Unknown or retired key identifiers return False. A trusted controller must
    independently construct trusted_keys and remove retired/revoked entries.
    This does not provide replay protection, revocation storage or CI lookup.
    """
    if not isinstance(receipt, Mapping) or set(receipt) != set(_FIELDS) | {"mac"}:
        raise ReceiptError("invalid issuer receipt fields")
    expected = dict(issuer=expected_issuer, requirement=expected_requirement,
                    reference=expected_reference, revision=expected_revision,
                    environment=expected_environment)
    for value in (*[receipt[k] for k in _FIELDS], *expected.values()):
        if not isinstance(value, str) or not value.strip() or len(value) > 500:
            raise ReceiptError("invalid issuer receipt context")
    key_id = receipt["key_id"]
    if not isinstance(key_id, str) or not key_id.isascii() or not all(
            ch.isalnum() or ch in "._-" for ch in key_id):
        raise ReceiptError("invalid key identifier")
    mac = receipt["mac"]
    if not isinstance(mac, str) or len(mac) != 64 or any(
            ch not in "0123456789abcdef" for ch in mac):
        raise ReceiptError("invalid authentication tag")
    if not isinstance(trusted_keys, Mapping):
        raise ReceiptError("invalid trusted key registry")
    # Never select an issuer based solely on an untrusted receipt.
    if receipt["issuer"] != expected_issuer:
        return False
    key = trusted_keys.get((expected_issuer, key_id))
    if key is None:
        return False
    if not isinstance(key, bytes) or len(key) < 32:
        raise ReceiptError("invalid trusted issuer key")
    try:
        payload = json.dumps({k: receipt[k] for k in _FIELDS},
                             sort_keys=True, separators=(",", ":"),
                             ensure_ascii=False).encode("utf-8")
    except (UnicodeError, ValueError, TypeError) as exc:
        raise ReceiptError("invalid receipt encoding") from exc
    tag = hmac.new(key, b"angel-acceptance-issuer-v2\x00" + payload,
                   hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, tag) and all(
        receipt[k] == value for k, value in expected.items())
