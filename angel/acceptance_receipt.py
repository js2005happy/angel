"""Offline verifier for externally signed acceptance receipts.

Only the holder of an independently provisioned secret may attest a receipt.
This module neither issues signatures nor accesses a key store or network.
Verification does not establish that a test ran or authorize tool execution.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Mapping


class ReceiptError(ValueError):
    """Malformed or unauthenticated receipt."""


_FIELDS = ("requirement", "reference", "revision", "environment")


def verify_receipt(receipt: Mapping[str, object], *, secret: bytes,
                   expected_requirement: str, expected_revision: str,
                   expected_environment: str) -> bool:
    """Check an exact-context, HMAC-SHA256 receipt without side effects.

    The caller MUST obtain secret through a trusted channel inaccessible to
    the agent/model and must establish the issuer's authority independently.
    False means no acceptance credit. Never log the secret or raw receipt.
    """
    if not isinstance(secret, bytes) or len(secret) < 32:
        raise ReceiptError("trusted secret must contain at least 32 bytes")
    if not isinstance(receipt, Mapping) or set(receipt) != set(_FIELDS) | {"mac"}:
        raise ReceiptError("invalid receipt fields")
    for field in _FIELDS:
        value = receipt[field]
        if not isinstance(value, str) or not value.strip() or len(value) > 500:
            raise ReceiptError("invalid receipt context")
    for value in (expected_requirement, expected_revision, expected_environment):
        if not isinstance(value, str) or not value.strip() or len(value) > 500:
            raise ReceiptError("invalid expected context")
    mac = receipt["mac"]
    if (not isinstance(mac, str) or len(mac) != 64
            or any(char not in "0123456789abcdef" for char in mac)):
        raise ReceiptError("invalid receipt authentication tag")
    payload = {field: receipt[field] for field in _FIELDS}
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=False).encode("utf-8")
    expected_mac = hmac.new(secret, b"angel-acceptance-v1\x00" + encoded,
                            hashlib.sha256).hexdigest()
    return (hmac.compare_digest(mac, expected_mac)
            and payload["requirement"] == expected_requirement
            and payload["revision"] == expected_revision
            and payload["environment"] == expected_environment)
