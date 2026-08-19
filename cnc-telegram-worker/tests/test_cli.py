from __future__ import annotations

import sys
import unittest
from unittest.mock import patch

from cnc_telegram_worker.__main__ import _main


class CliFailClosedTest(unittest.TestCase):
    def test_once_rejects_arbitrary_scan_request_before_worker_creation(self) -> None:
        capture = object()
        with patch.object(sys, "argv", [
            "cnc-telegram-worker",
            "once",
            "--days",
            "1",
            "--scan-request-id",
            "not-a-persisted-approval",
        ]), patch("cnc_telegram_worker.__main__.WorkerConfig.from_env") as from_env:
            with self.assertRaisesRegex(SystemExit, "persisted approved scan/import"):
                _main(capture)  # type: ignore[arg-type]
        from_env.assert_not_called()

    def test_svg_refresh_backfill_rejects_history_read_before_worker_creation(self) -> None:
        capture = object()
        with patch.object(sys, "argv", ["cnc-telegram-worker", "svg-refresh-backfill", "--days", "1"]), \
             patch("cnc_telegram_worker.__main__.WorkerConfig.from_env") as from_env:
            with self.assertRaisesRegex(SystemExit, "history reads require the Phase B"):
                _main(capture)  # type: ignore[arg-type]
        from_env.assert_not_called()


if __name__ == "__main__":
    unittest.main()
