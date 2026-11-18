"""Worker protocol v1: stdio JSONL between a host process and the Python worker.

This is the public contract for the hybrid Go migration: a host (later, a
Go binary) spawns ``python3 -m nyra.worker`` and drives one Agent session
over three channels:

- stdin:  JSONL requests from the host (``run`` / ``approval_decision`` /
  ``stop`` / ``ping``).
- stdout: JSONL events from the worker, one object per line, flushed after
  every line. stdout carries ONLY protocol lines; anything else (warnings,
  diagnostics, stray prints) goes to stderr so the stream stays parseable.
- stderr: human-readable logs. Never part of the protocol.

Rules every implementation must follow:

- Every line is one JSON object with ``type`` and ``id``. Requests and
  responses pair up by ``id``; an ``approval_request`` and its
  ``approval_decision`` share the same ``id``.
- ``protocol_version`` is 1. A host that does not understand version 1 must
  refuse to speak the protocol rather than guessing.
- Unknown request ``type`` values are ignored and logged, never fatal.
  Unknown fields inside a known request are ignored and logged, except the
  run-request overrides listed in :func:`validate_run_request`, which are
  rejected loudly so a sender never believes an option took effect when it
  did not.
- The worker runs a single provider (chosen at startup) and never builds a
  fallback chain. A ``run`` request with ``fallback: true`` is rejected.
- Approval is fail-closed: a decision is only accepted when it names the
  pending request (matching ``id`` and ``approval_id``), carries
  ``decided_by: "human"``, and has a boolean ``approved``. Anything else is
  rejected and logged; a timeout is a refusal, never an approval.
- One ``run`` at a time. The host must wait for a terminal event
  (``run_completed`` / ``run_incomplete`` / ``run_failed``) before sending
  the next ``run``.

Version history:

- 1: initial protocol (Batch 1 of the Go migration).
"""

import json
import secrets

PROTOCOL_VERSION = 1

# Requests: host -> worker (stdin).
REQUEST_TYPES = frozenset({"run", "approval_decision", "stop", "ping"})

# Events: worker -> host (stdout).
EVENT_TYPES = frozenset({
    "run_started",
    "run_completed",
    "run_incomplete",
    "run_failed",
    "tool_start",
    "tool_result",
    "assistant",
    "final",
    "usage",
    "approval_request",
    "approval_result",
    "model_switch",
    "turn_limit",
    "auto_compact",
    "auto_compact_failed",
    "auto_compact_skipped",
    "pong",
    "error",
})

# How long the worker waits for an approval_decision before refusing.
# Same value as webui.APPROVAL_TIMEOUT; kept as a plain constant here so the
# worker does not import the whole web UI server.
APPROVAL_TIMEOUT = 600.0

# Run-request keys that v1 deliberately does not support per run. If a
# sender sets one, the request is rejected with a clear message instead of
# silently ignoring an option the sender believed took effect. Provider,
# model and mode are fixed when the worker starts; a new session (a new
# worker process) is how the host switches them.
_UNSUPPORTED_RUN_KEYS = ("provider", "model", "mode", "max_turns", "session_id", "resume")


def new_id(prefix: str = "req") -> str:
    """Return a globally unique message id, e.g. ``req-9f2c...``."""
    return f"{prefix}-{secrets.token_hex(8)}"


def encode_line(event_type: str, seq: int, **payload) -> str:
    """Encode one protocol line (no trailing newline).

    ASCII-only JSON keeps the stream safe on any pipe encoding; the host
    parses it as ordinary JSON.
    """
    event = {
        "protocol_version": PROTOCOL_VERSION,
        "seq": seq,
        "type": event_type,
    }
    event.update(payload)
    return json.dumps(event, ensure_ascii=True, separators=(",", ":"))


def decode_line(line: str):
    """Parse one stdin line.

    Returns ``(obj, None)`` on success, ``(None, None)`` for a blank line
    (skip silently), or ``(None, error)`` for a malformed line. A parsed
    object always has a string ``type``; unknown types are not an error
    here -- the caller ignores them and logs.
    """
    if not line.strip():
        return None, None
    try:
        obj = json.loads(line)
    except (ValueError, UnicodeError):
        return None, "not valid JSON"
    if not isinstance(obj, dict):
        return None, "not a JSON object"
    if not isinstance(obj.get("type"), str) or not obj["type"]:
        return None, "missing or invalid type"
    return obj, None


def ensure_request_id(obj: dict) -> str:
    """Return the request's ``id``, generating one when it is missing."""
    request_id = obj.get("id")
    if isinstance(request_id, str) and request_id:
        return request_id
    return new_id("req")


def validate_run_request(obj: dict):
    """Validate a ``run`` request.

    Returns an error message string, or ``None`` when the request is valid.
    Unknown extra keys are allowed (ignored and logged by the caller) so
    the protocol can grow additively; the known per-run overrides below
    are rejected instead, because silently ignoring them would lie to the
    sender about what took effect.
    """
    task = obj.get("task")
    if not isinstance(task, str) or not task.strip():
        return "run 请求需要非空的 task 字符串"
    fallback = obj.get("fallback", False)
    if not isinstance(fallback, bool):
        return "run 请求的 fallback 必须是布尔值"
    if fallback:
        return "worker 不支持兜底：run 请求的 fallback 必须为 false（worker 只用启动时指定的单个 provider）"
    for key in _UNSUPPORTED_RUN_KEYS:
        if key in obj:
            return (
                f"v1 不支持在 run 请求里指定 {key}，"
                "请在启动 worker 时指定（新会话请拉起新的 worker 进程）"
            )
    return None


def validate_approval_decision(obj: dict, pending):
    """Validate an ``approval_decision`` against the pending request.

    ``pending`` is ``{"id": ..., "approval_id": ...}`` or ``None`` when no
    approval is waiting. Returns ``(approved, None)`` on success or
    ``(None, error)`` when the decision must be rejected. Rejection here
    means "this decision does not count"; the worker keeps waiting unless
    the decision names the pending approval but fails validation, which
    the caller treats as a fail-closed refusal.
    """
    if pending is None:
        return None, "no pending approval"
    if obj.get("id") != pending["id"]:
        return None, "approval_decision 的 id 与待处理的审批请求不匹配"
    if obj.get("approval_id") != pending["approval_id"]:
        return None, "approval_decision 的 approval_id 与待处理的审批请求不匹配"
    if obj.get("decided_by") != "human":
        return None, "approval_decision 的 decided_by 必须为 human"
    approved = obj.get("approved")
    if not isinstance(approved, bool):
        return None, "approval_decision 的 approved 必须是布尔值"
    return approved, None
