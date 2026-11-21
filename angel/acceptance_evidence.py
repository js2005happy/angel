"""Pure, read-only acceptance evidence assessment; never authorizes tool replay.

No persistence, network calls, approval changes, or execution side effects.
A recorded claim is not proof that the requested environment was verified.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence

LEVELS = ("changed", "static_reviewed", "tests_passed", "target_verified")
_LEVEL_INDEX = {name: index for index, name in enumerate(LEVELS)}


class AcceptanceError(ValueError):
    """Invalid or ambiguous acceptance evidence."""


def assess_acceptance(
    requirements: Sequence[str],
    evidence: Mapping[str, Sequence[Mapping[str, object]]],
) -> dict[str, object]:
    """Return a conservative, serializable summary of explicitly supplied evidence.

    Each evidence item must contain a recognized 'level' and a nonempty
    'reference' (commit, check URL, or user-supplied acceptance artifact).
    References are never dereferenced or treated as trusted attestations.
    A reported target verification must identify the tested revision and
    environment; both are untrusted descriptions, not independent proof.
    Only target_verified can satisfy a requirement, and even that is a
    *reported* state, not independent verification by Angel.
    """
    if isinstance(requirements, (str, bytes)) or not isinstance(requirements, Sequence):
        raise AcceptanceError("requirements must be a sequence")
    if not isinstance(evidence, Mapping):
        raise AcceptanceError("evidence must be a mapping")
    if not requirements or len(requirements) > 100:
        raise AcceptanceError("requirement count out of bounds")
    if any(not isinstance(item, str) or not item.strip() or len(item) > 200
           for item in requirements):
        raise AcceptanceError("invalid requirement")
    if len(set(requirements)) != len(requirements):
        raise AcceptanceError("duplicate requirement")
    if set(evidence) - set(requirements):
        raise AcceptanceError("evidence for unknown requirement")

    items = []
    for requirement in requirements:
        entries = evidence.get(requirement, ())
        if isinstance(entries, (str, bytes)) or not isinstance(entries, Sequence) or len(entries) > 100:
            raise AcceptanceError("invalid evidence sequence")
        highest = None
        references = []
        target_contexts = []
        for entry in entries:
            if not isinstance(entry, Mapping):
                raise AcceptanceError("invalid evidence entry")
            level = entry.get("level")
            reference = entry.get("reference")
            if not isinstance(level, str) or level not in _LEVEL_INDEX:
                raise AcceptanceError("unknown evidence level")
            if not isinstance(reference, str) or not reference.strip() or len(reference) > 500:
                raise AcceptanceError("missing or oversized evidence reference")
            if level == "target_verified":
                revision = entry.get("revision")
                environment = entry.get("environment")
                if (not isinstance(revision, str) or not revision.strip() or len(revision) > 200
                        or not isinstance(environment, str) or not environment.strip()
                        or len(environment) > 200):
                    raise AcceptanceError("target verification requires revision and environment")
                target_contexts.append({"revision": revision, "environment": environment,
                                        "reference": reference})
            references.append(reference)
            if highest is None or _LEVEL_INDEX[level] > _LEVEL_INDEX[highest]:
                highest = level
        items.append({
            "requirement": requirement,
            "reported_level": highest or "unverified",
            "references": references,
            "reported_target_contexts": target_contexts,
            "reported_target_verified": highest == "target_verified",
        })
    incomplete = [item["requirement"] for item in items if not item["reported_target_verified"]]
    return {
        "requirements": items,
        "incomplete": incomplete,
        "reported_complete": not incomplete,
        "independently_verified": False,
        "safe_to_auto_resume": False,
    }
