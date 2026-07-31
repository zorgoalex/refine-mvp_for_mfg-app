from __future__ import annotations

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
            state.mark_posted("telegram:-100:1", "hash-a", 1)

            same = StateStore(path).next_version("telegram:-100:1", "hash-a")
            self.assertEqual(same.source_version, 1)
            self.assertFalse(same.changed)

            changed = StateStore(path).next_version("telegram:-100:1", "hash-b")
            self.assertEqual(changed.source_version, 2)
            self.assertTrue(changed.changed)

    def test_source_fingerprint_can_skip_before_ocr_after_successful_post(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.json"
            state = StateStore(path)

            self.assertFalse(state.source_unchanged("telegram:-100:1", "source-a"))
            state.mark_posted("telegram:-100:1", "hash-a", 1, "source-a")

            restored = StateStore(path)
            self.assertTrue(restored.source_unchanged("telegram:-100:1", "source-a"))
            self.assertFalse(restored.source_unchanged("telegram:-100:1", "source-b"))

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
