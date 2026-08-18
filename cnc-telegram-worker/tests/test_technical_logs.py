from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from cnc_telegram_worker.technical_logs import TechnicalLogSpool, flush_technical_logs_once, sanitize_line


class TechnicalLogsTest(unittest.TestCase):
    def test_redacts_credentials_paths_and_phone_before_spooling(self) -> None:
        message, redacted, truncated, categories = sanitize_line(
            "Bearer abcdefghijklmnop password=hunter2 /data/session/live.session +7 777 123 45 67",
        )
        self.assertNotIn("abcdefghijklmnop", message)
        self.assertNotIn("hunter2", message)
        self.assertNotIn("live.session", message)
        self.assertNotIn("777 123", message)
        self.assertTrue(redacted)
        self.assertFalse(truncated)
        self.assertIn("authorization", categories)
        self.assertIn("credential", categories)
        self.assertIn("session_path", categories)
        self.assertIn("phone", categories)

    def test_persists_lines_and_deletes_only_after_delivery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            spool = TechnicalLogSpool(Path(directory, "spool.sqlite3"))
            spool.capture("stderr", "backend exploded")
            spool.close()
            pending = spool.pending_batch()
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0]["message"], "backend exploded")

            sent = []

            async def sender(payload):
                sent.append(payload)
                return {"accepted": 1}

            accepted = asyncio.run(flush_technical_logs_once(spool, sender))
            self.assertEqual(accepted, 1)
            self.assertEqual(len(sent[0]["lines"]), 1)
            self.assertEqual(spool.pending_batch(), [])

    def test_keeps_lines_when_backend_delivery_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            spool = TechnicalLogSpool(Path(directory, "spool.sqlite3"))
            spool.capture("stdout", "worker heartbeat")
            spool.close()

            async def sender(_payload):
                raise RuntimeError("backend offline")

            with self.assertRaisesRegex(RuntimeError, "backend offline"):
                asyncio.run(flush_technical_logs_once(spool, sender))
            self.assertEqual(len(spool.pending_batch()), 1)

    def test_recovers_after_transient_sqlite_writer_error_without_losing_line(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            spool = TechnicalLogSpool(Path(directory, "spool.sqlite3"))
            original = spool._write_line
            attempts = 0

            def flaky_write(connection, line):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise sqlite3.OperationalError("database is locked")
                return original(connection, line)

            spool._write_line = flaky_write
            spool.capture("stderr", "preserve me")
            spool.close()
            self.assertGreaterEqual(attempts, 2)
            self.assertEqual([line["message"] for line in spool.pending_batch()], ["preserve me"])

    def test_persists_explicit_loss_record_before_next_normal_line(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            spool = TechnicalLogSpool(Path(directory, "spool.sqlite3"))
            spool._dropped = 3
            spool.capture("stdout", "next normal line")
            spool.close()
            pending = spool.pending_batch()
            self.assertEqual(pending[0]["redactionCategories"], ["loss_accounting"])
            self.assertEqual(pending[0]["droppedBefore"], 3)
            self.assertIn("3 line(s) dropped", pending[0]["message"])
            self.assertEqual(pending[1]["message"], "next normal line")

    def test_serializes_concurrent_stdout_and_stderr_sequences(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            spool = TechnicalLogSpool(Path(directory, "spool.sqlite3"))
            threads = [threading.Thread(target=spool.capture, args=("stdout" if index % 2 else "stderr", f"line-{index}")) for index in range(40)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            spool.close()
            sequences = [line["sequence"] for line in spool.pending_batch()]
            self.assertEqual(sequences, list(range(1, 41)))

    def test_spool_cap_evicts_oldest_with_loss_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch("cnc_telegram_worker.technical_logs.MAX_SPOOL_ROWS", 2):
            spool = TechnicalLogSpool(Path(directory, "spool.sqlite3"))
            for index in range(3):
                spool.capture("stdout", f"line-{index}")
            spool.close()
            pending = spool.pending_batch()
            self.assertEqual([line["message"] for line in pending], ["line-1", "line-2"])
            self.assertEqual(pending[-1]["droppedBefore"], 1)
            self.assertIn("spool_eviction", pending[-1]["redactionCategories"])


if __name__ == "__main__":
    unittest.main()
