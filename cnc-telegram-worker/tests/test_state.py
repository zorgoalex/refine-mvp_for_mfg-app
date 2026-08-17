from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cnc_telegram_worker.cleanup import cleanup_temp_dir
from cnc_telegram_worker.state import StateStore


class StateStoreTest(unittest.TestCase):
    def test_versions_increment_only_when_payload_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            state = StateStore(path)

            first = state.next_version("telegram:-100:1", "hash-a")
            self.assertEqual(first.source_version, 1)
            self.assertTrue(first.changed)
            state.mark_posted(
                "telegram:-100:1",
                "hash-a",
                1,
                svg_cut_import_status="imported",
            )

            same = StateStore(path).next_version("telegram:-100:1", "hash-a")
            self.assertEqual(same.source_version, 1)
            self.assertFalse(same.changed)

            changed = StateStore(path).next_version("telegram:-100:1", "hash-b")
            self.assertEqual(changed.source_version, 2)
            self.assertTrue(changed.changed)

    def test_legacy_no_status_state_advances_source_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            path.write_text(json.dumps({
                "packets": {
                    "telegram:-100:1": {
                        "payloadHash": "hash-a",
                        "sourceFingerprint": "source-a",
                        "sourceVersion": 1,
                    },
                },
            }), encoding="utf-8")
            state = StateStore(path)

            decision = state.next_version("telegram:-100:1", "hash-a")

            self.assertTrue(decision.changed)
            self.assertEqual(decision.source_version, 2)

    def test_source_fingerprint_can_skip_before_ocr_after_successful_post(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            state = StateStore(path)

            self.assertFalse(state.source_unchanged("telegram:-100:1", "source-a"))
            state.mark_posted("telegram:-100:1", "hash-a", 1, "source-a")

            restored = StateStore(path)
            self.assertFalse(restored.source_unchanged("telegram:-100:1", "source-a"))
            self.assertFalse(restored.posted_packet_matches("telegram:-100:1", "hash-a", 1))

            restored.mark_posted(
                "telegram:-100:1",
                "hash-a",
                1,
                "source-a",
                svg_cut_import_status="imported",
            )
            restored = StateStore(path)
            self.assertTrue(restored.source_unchanged("telegram:-100:1", "source-a"))
            self.assertTrue(restored.posted_packet_matches("telegram:-100:1", "hash-a", 1))
            self.assertFalse(restored.source_unchanged("telegram:-100:1", "source-b"))

    def test_skipped_source_file_duplicate_does_not_short_circuit_future_scans(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            state = StateStore(path)

            state.mark_posted(
                "telegram:-100:1",
                "hash-a",
                1,
                "source-a",
                svg_cut_import_status="skipped",
                cut_job_id=104,
                source_file_sha="a" * 64,
            )

            restored = StateStore(path)
            self.assertFalse(restored.source_unchanged("telegram:-100:1", "source-a"))
            self.assertFalse(restored.posted_packet_matches("telegram:-100:1", "hash-a", 1))
            self.assertFalse(restored.imported_svg_cut_job_confirmed("telegram:-100:1"))
            self.assertEqual(restored.next_version("telegram:-100:1", "hash-a").source_version, 2)
            self.assertEqual(restored._state["packets"]["telegram:-100:1"]["lastSkippedPayloadHash"], "hash-a")
            self.assertEqual(restored._state["packets"]["telegram:-100:1"]["lastSkippedSourceVersion"], 1)

    def test_legacy_skipped_source_file_duplicate_advances_source_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            path.write_text(json.dumps({
                "packets": {
                    "telegram:-100:1": {
                        "payloadHash": "hash-a",
                        "sourceFingerprint": "source-a",
                        "sourceVersion": 1,
                        "svgCutImportStatus": "skipped",
                    },
                },
            }), encoding="utf-8")
            state = StateStore(path)

            decision = state.next_version("telegram:-100:1", "hash-a")

            self.assertTrue(decision.changed)
            self.assertEqual(decision.source_version, 2)

    def test_skipped_source_file_duplicate_clears_local_cutting_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            state = StateStore(path)

            state.assign_cutting_sequence_number("telegram:-100:1", existing_number=13)
            state.mark_cutting_sequence_replied("telegram:-100:1")
            state.mark_posted(
                "telegram:-100:1",
                "hash-a",
                1,
                "source-a",
                svg_cut_import_status="skipped",
                cut_job_id=104,
            )

            restored = StateStore(path)
            self.assertIsNone(restored.cutting_sequence_number("telegram:-100:1"))
            self.assertFalse(restored.cutting_sequence_replied("telegram:-100:1"))

    def test_existing_telegram_cutting_sequence_reply_replaces_local_memory(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            state = StateStore(path)

            state.assign_cutting_sequence_number("telegram:-100:1", existing_number=7)
            state.assign_cutting_sequence_number("telegram:-100:1", existing_number=8)

            self.assertEqual(StateStore(path).cutting_sequence_number("telegram:-100:1"), 8)

    def test_cleanup_refuses_root(self) -> None:
        with self.assertRaises(ValueError):
            cleanup_temp_dir(Path("/"), 24)


if __name__ == "__main__":
    unittest.main()
