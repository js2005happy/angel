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
    *,
    expected_revision: str | None = None,
    expected_environment: str | None = None,
    recognized_references: Sequence[str] | None = None,
    reference_scopes: Mapping[str, str] | None = None,
) -> dict[str, object]:
    """Return a conservative, serializable summary of explicitly supplied evidence.

    Each evidence item must contain a recognized 'level' and a nonempty
    'reference' (commit, check URL, or user-supplied acceptance artifact).
    References are never dereferenced or treated as trusted attestations.
    A reported target verification must identify the tested revision and
    environment; both are untrusted descriptions, not independent proof.
    When both expected target fields are supplied, only exact matching
    target reports count toward reported completion. A mismatch stays open.
    When recognized_references is supplied, only references on that explicit
    caller-provided list count toward reported completion. The list is not
    independently authenticated and never proves a successful deployment.
    When reference_scopes is supplied, target references must additionally
    be explicitly scoped to the current requirement. These scopes are caller
    assertions, not independently authenticated provenance.
    A target receipt reused across requirements is ambiguous and cannot\n    satisfy either requirement, even without optional scopes.\n    Conflicting revision/environment claims for the same receipt are also\n    ambiguous, including when supplied under the same requirement.\n    Only target_verified can satisfy a requirement, and even that is a
    *reported* state, not independent verification by Angel.
    """
    if (expected_revision is None) != (expected_environment is None):
        raise AcceptanceError("expected revision and environment must be supplied together")
    for expected in (expected_revision, expected_environment):
        if expected is not None and (not isinstance(expected, str) or not expected.strip()
                                     or len(expected) > 200):
            raise AcceptanceError("invalid expected target context")
    recognized = None
    if recognized_references is not None:
        if (isinstance(recognized_references, (str, bytes))
                or not isinstance(recognized_references, Sequence)
                or len(recognized_references) > 1000
                or any(not isinstance(ref, str) or not ref.strip() or len(ref) > 500
                       for ref in recognized_references)):
            raise AcceptanceError("invalid recognized references")
        recognized = set(recognized_references)
        if len(recognized) != len(recognized_references):
            raise AcceptanceError("duplicate recognized reference")
    if reference_scopes is not None:
        if (not isinstance(reference_scopes, Mapping) or len(reference_scopes) > 1000
                or any(not isinstance(ref, str) or not ref.strip() or len(ref) > 500
                       or not isinstance(scope, str) or not scope.strip() or len(scope) > 200
                       for ref, scope in reference_scopes.items())):
            raise AcceptanceError("invalid reference scopes")
        if recognized is not None and set(reference_scopes) - recognized:
            raise AcceptanceError("reference scopes contain unrecognized references")
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
    if reference_scopes is not None and set(reference_scopes.values()) - set(requirements):
        raise AcceptanceError("reference scopes contain unknown requirements")
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
        matching_target = False
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
                matches = (expected_revision is None or
                           (revision == expected_revision and environment == expected_environment))
                scope_matches = (reference_scopes is None or
                                 reference_scopes.get(reference) == requirement)
                matching_target = matching_target or (matches and scope_matches and
                                                      (recognized is None or reference in recognized))
                target_contexts.append({"revision": revision, "environment": environment,
                                        "reference": reference, "matches_expected": matches,
                                        "reference_recognized": recognized is None or reference in recognized,
                                        "reference_scope_matches": scope_matches})
            references.append(reference)
            if highest is None or _LEVEL_INDEX[level] > _LEVEL_INDEX[highest]:
                highest = level
        items.append({
            "requirement": requirement,
            "reported_level": highest or "unverified",
            "references": references,
            "reported_target_contexts": target_contexts,
            "reported_target_verified": matching_target,
        })
    # A target receipt reused across different requirements is ambiguous, even
    # when the caller omitted optional reference scopes. Reject *all* affected
    # requirements rather than trusting whichever entry was visited first.
    target_owners = {}
    for item in items:
        for context in item["reported_target_contexts"]:
            target_owners.setdefault(context["reference"], set()).add(item["requirement"])
    # A reference must describe one consistent target context. Conflicting
    # claims are rejected even when they appear under the same requirement;
    # otherwise a caller could cherry-pick whichever context happens to match.
    target_contexts_by_ref = {}
    for item in items:
        for context in item["reported_target_contexts"]:
            target_contexts_by_ref.setdefault(context["reference"], set()).add(
                (context["revision"], context["environment"])
            )
    conflicting = {ref for ref, contexts in target_contexts_by_ref.items()
                   if len(contexts) > 1}
    shared = {ref for ref, owners in target_owners.items() if len(owners) > 1}
    if shared or conflicting:
        for item in items:
            for context in item["reported_target_contexts"]:
                context["reference_shared"] = context["reference"] in shared
                context["reference_context_conflict"] = context["reference"] in conflicting
            # Re-evaluate from individually eligible, non-shared receipts.
            item["reported_target_verified"] = any(
                context["matches_expected"] and context["reference_recognized"]
                and context["reference_scope_matches"] and not context["reference_shared"]
                and not context["reference_context_conflict"]
                for context in item["reported_target_contexts"]
            )
    incomplete = [item["requirement"] for item in items if not item["reported_target_verified"]]
    return {
        "requirements": items,
        "incomplete": incomplete,
        "reported_complete": not incomplete,
        "independently_verified": False,
        "safe_to_auto_resume": False,
    }
