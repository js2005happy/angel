"""Static regression cases for self-reported acceptance provenance (not executed)."""
import unittest

from angel.acceptance_evidence import AcceptanceError, assess_acceptance


class AcceptanceProvenanceTests(unittest.TestCase):
    def test_target_requires_revision_and_environment(self):
        for entry in (
            {"level": "target_verified", "reference": "ticket-1"},
            {"level": "target_verified", "reference": "ticket-1", "revision": "abc"},
            {"level": "target_verified", "reference": "ticket-1", "revision": "abc", "environment": " "},
            {"level": "target_verified", "reference": "ticket-1", "revision": 123, "environment": "staging"},
        ):
            with self.subTest(entry=entry), self.assertRaises(AcceptanceError):
                assess_acceptance(["checkout"], {"checkout": [entry]})

    def test_reported_target_still_not_independently_verified(self):
        result = assess_acceptance(["checkout"], {"checkout": [{
            "level": "target_verified", "reference": "manual-acceptance-1",
            "revision": "commit-abc", "environment": "staging Chrome",
        }]})
        self.assertTrue(result["reported_complete"])
        self.assertFalse(result["independently_verified"])
        self.assertFalse(result["safe_to_auto_resume"])
        self.assertEqual(result["requirements"][0]["reported_target_contexts"], [{
            "revision": "commit-abc", "environment": "staging Chrome",
            "reference": "manual-acceptance-1",
        }])

    def test_lower_levels_remain_backward_compatible(self):
        result = assess_acceptance(["checkout"], {"checkout": [
            {"level": "static_reviewed", "reference": "review-1"},
        ]})
        self.assertEqual(result["incomplete"], ["checkout"])
        self.assertEqual(result["requirements"][0]["reported_target_contexts"], [])


if __name__ == "__main__":
    unittest.main()
