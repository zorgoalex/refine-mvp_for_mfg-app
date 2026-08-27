from __future__ import annotations

import asyncio
import signal
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from cnc_telegram_worker.__main__ import run_with_technical_delivery
from cnc_telegram_worker.erp_client import SessionLeaseLost
from cnc_telegram_worker.technical_logs import (
    TechnicalLogCapture,
    TechnicalLogSpool,
    deliver_technical_logs,
    flush_technical_logs_once,
    sanitize_line,
)


class TechnicalLogsTest(unittest.TestCase):
    def test_capture_identity_matches_explicit_session_identity(self) -> None:
        worker_instance_id = str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as directory:
            capture = TechnicalLogCapture(Path(directory, "spool.sqlite3"), worker_instance_id=worker_instance_id)
            try:
                capture.spool.capture("stdout", "correlated\n")
                for _ in range(20):
                    if capture.spool.pending_batch():
                        break
                    time.sleep(0.01)
                self.assertEqual(capture.spool.worker_instance_id, worker_instance_id)
                self.assertEqual(capture.spool.pending_batch()[0]["workerInstanceId"], worker_instance_id)
            finally:
                capture.close()

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

    def test_delivery_propagates_session_lease_loss_and_sets_fatal_signal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            spool = TechnicalLogSpool(Path(directory, "spool.sqlite3"))
            spool.capture("stderr", "lease must fence delivery")
            spool.close()
            stop_event = asyncio.Event()
            fatal_event = asyncio.Event()

            async def sender(_payload):
                raise SessionLeaseLost("stale technical delivery")

            with self.assertRaises(SessionLeaseLost):
                asyncio.run(deliver_technical_logs(
                    spool,
                    sender,
                    stop_event,
                    interval_seconds=1,
                    heartbeat_seconds=60,
                    fatal_event=fatal_event,
                ))
            self.assertTrue(stop_event.is_set())
            self.assertTrue(fatal_event.is_set())

    def test_delivery_waits_until_session_lease_is_ready(self) -> None:
        async def scenario(spool: TechnicalLogSpool) -> None:
            sent = asyncio.Event()
            ready = False
            stop_event = asyncio.Event()

            async def sender(_payload):
                sent.set()

            task = asyncio.create_task(deliver_technical_logs(
                spool,
                sender,
                stop_event,
                interval_seconds=0.01,
                heartbeat_seconds=60,
                ready=lambda: ready,
            ))
            await asyncio.sleep(0.03)
            self.assertFalse(sent.is_set())
            ready = True
            await asyncio.wait_for(sent.wait(), timeout=1)
            stop_event.set()
            await task

        with tempfile.TemporaryDirectory() as directory:
            spool = TechnicalLogSpool(Path(directory, "spool.sqlite3"))
            spool.capture("stderr", "wait for lease")
            spool.close()
            asyncio.run(scenario(spool))

    def test_run_with_technical_delivery_propagates_lease_loss(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            spool = TechnicalLogSpool(Path(directory, "spool.sqlite3"))
            spool.capture("stderr", "lease must stop serve")
            spool.close()
            capture = SimpleNamespace(spool=spool)

            async def sender(_payload):
                raise SessionLeaseLost("stale technical delivery")

            worker = SimpleNamespace(
                erp=SimpleNamespace(
                    technical_log_batch=sender,
                    session_lease=object(),
                    release_worker_session=AsyncMock(),
                    set_session_lease=lambda _lease: None,
                ),
                config=SimpleNamespace(
                    technical_log_flush_interval_seconds=1,
                    technical_log_heartbeat_seconds=60,
                ),
            )

            async def operation(fatal_event: asyncio.Event) -> None:
                await fatal_event.wait()
                raise SessionLeaseLost("serve stopped after technical lease loss")

            with self.assertRaises(SessionLeaseLost):
                asyncio.run(run_with_technical_delivery(worker, capture, operation))

    def test_sigterm_runs_cleanup_and_releases_session_lease(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            spool = TechnicalLogSpool(Path(directory, "spool.sqlite3"))
            spool.capture("stdout", "flush before release")
            spool.close()
            capture = SimpleNamespace(spool=spool)
            release = AsyncMock()
            operation_stopped = asyncio.Event()

            async def sender(_payload):
                return {"accepted": 1}

            worker = SimpleNamespace(
                erp=SimpleNamespace(
                    technical_log_batch=sender,
                    session_lease=object(),
                    release_worker_session=release,
                    set_session_lease=lambda _lease: None,
                ),
                config=SimpleNamespace(
                    technical_log_flush_interval_seconds=1,
                    technical_log_heartbeat_seconds=60,
                ),
            )

            async def operation(_fatal_event: asyncio.Event) -> None:
                try:
                    await asyncio.Event().wait()
                finally:
                    operation_stopped.set()

            async def scenario() -> None:
                task = asyncio.create_task(run_with_technical_delivery(worker, capture, operation))
                await asyncio.sleep(0.01)
                signal.raise_signal(signal.SIGTERM)
                await asyncio.wait_for(task, timeout=1)

            asyncio.run(scenario())
            self.assertTrue(operation_stopped.is_set())
            release.assert_awaited_once()

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
