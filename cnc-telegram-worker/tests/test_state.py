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

    def test_cleanup_refuses_root(self) -> None:
        with self.assertRaises(ValueError):
            cleanup_temp_dir(Path("/"), 24)


if __name__ == "__main__":
    unittest.main()
