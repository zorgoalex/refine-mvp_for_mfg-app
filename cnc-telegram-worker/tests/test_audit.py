from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

telethon_stub = types.ModuleType("telethon")
telethon_stub.TelegramClient = object
telethon_stub.utils = types.SimpleNamespace(get_peer_id=lambda entity: entity)
sys.modules.setdefault("telethon", telethon_stub)

from cnc_telegram_worker.audit import (
    AuditSpool,
    ScanAudit,
    reconcile_pending_processing_attempts,
    reconcile_pending_replies,
    sanitize_text,
    telegram_message_record,
)


class FakeMessage:
    def __init__(
        self,
        message_id: int,
        text: str = "",
        filename: str | None = None,
        *,
        reply_to: int | None = None,
        sender_id: int = 9_007_199_254_740_993,
        outgoing: bool = False,
        created_at: datetime | None = None,
    ) -> None:
        self.id = message_id
        self.date = created_at or datetime(2026, 8, 6, 8, 0, tzinfo=timezone.utc)
        self.edit_date = None
        self.raw_text = text
        self.file = types.SimpleNamespace(name=filename, mime_type="image/svg+xml") if filename else None
        self.reply_to = types.SimpleNamespace(reply_to_msg_id=reply_to) if reply_to else None
        self.sender_id = sender_id
        self.out = outgoing
        self.reactions = None
        self.photo = None


class FakeTelegramClient:
    def __init__(self, messages: list[FakeMessage]) -> None:
        self.messages = messages

    async def iter_messages(self, *_args: object, **_kwargs: object):
        for message in self.messages:
            yield message


class CrashAfterFirstTelegramClient(FakeTelegramClient):
    async def iter_messages(self, *_args: object, **_kwargs: object):
        yield self.messages[0]
        raise KeyboardInterrupt("simulated process death")


class AuditSpoolTest(unittest.IsolatedAsyncioTestCase):
    def test_rejects_nonpersistent_path_without_explicit_test_override(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, "under /data"):
                AuditSpool(Path(temp) / "audit.sqlite3")

    async def test_wal_outbox_survives_restart_and_flushes_exact_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "audit.sqlite3"
            first = AuditSpool(path, allow_unsafe_path=True)
            first.enqueue({"scan": {"scanId": "one"}}, outbox_id="event-one")
            first.close()

            second = AuditSpool(path, allow_unsafe_path=True)
            delivered: list[dict[str, object]] = []

            async def sender(payload: dict[str, object]) -> None:
                delivered.append(payload)

            self.assertEqual(await second.flush(sender), 1)
            self.assertEqual(delivered, [{"scan": {"scanId": "one"}}])
            self.assertEqual(await second.flush(sender), 0)
            second.close()

    async def test_message_workday_uses_message_timestamp_not_historical_scan_day(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spool = AuditSpool(Path(temp) / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(
                spool, "-100123", date(2026, 7, 27), "77", "v1", False,
                business_timezone=timezone.utc,
            )
            future = FakeMessage(10862, created_at=datetime(2026, 8, 7, 10, 56, tzinfo=timezone.utc))

            await audit.observe(future, "reply_search", 1, decision_code="reply_wrong_target")

            payload = json.loads(spool.connection.execute(
                "SELECT payload_json FROM audit_outbox WHERE outbox_id NOT LIKE 'scan-running:%' "
                "ORDER BY created_at DESC, outbox_id DESC LIMIT 1",
            ).fetchone()[0])
            self.assertEqual(payload["scan"]["workday"], "2026-07-27")
            self.assertEqual(payload["messages"][0]["workday"], "2026-08-07")
            spool.close()

    def test_startup_selftest_never_enters_deliverable_outbox(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spool = AuditSpool(Path(temp) / "audit.sqlite3", allow_unsafe_path=True)
            self.assertEqual(
                spool.connection.execute("SELECT count(*) FROM audit_outbox WHERE payload_json='{}'").fetchone()[0],
                0,
            )
            self.assertEqual(spool.connection.execute("SELECT count(*) FROM audit_selftest").fetchone()[0], 0)
            spool.close()

    async def test_observation_rolls_back_scan_progress_when_outbox_write_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spool = AuditSpool(Path(temp) / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 8, 6), "77", "v1", False)
            initial_outbox = spool.connection.execute("SELECT count(*) FROM audit_outbox").fetchone()[0]
            install_outbox_failure(spool)

            with self.assertRaisesRegex(RuntimeError, "forced outbox failure"):
                await audit.observe(FakeMessage(10, filename="layout.svg"), "day_history", 1)

            saved_scan = json.loads(spool.connection.execute(
                "SELECT scan_json FROM audit_scans WHERE scan_id=?", (audit.scan["scanId"],)
            ).fetchone()[0])
            self.assertEqual(saved_scan["dayYieldedCount"], 0)
            self.assertEqual(spool.connection.execute("SELECT count(*) FROM audit_outbox").fetchone()[0], initial_outbox)
            spool.close()

    async def test_reply_search_marks_only_selected_reply_as_used(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spool = AuditSpool(Path(temp) / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 8, 6), "77", "v1", False)
            await audit.observe(
                FakeMessage(11, "Раскрой №7", reply_to=10, outgoing=True),
                "reply_search", 1, decision_code="reply_selected",
            )
            await audit.observe(
                FakeMessage(12, "Раскрой №8", reply_to=10, sender_id=88, outgoing=True),
                "reply_search", 2, decision_code="reply_foreign_sender",
            )
            await audit.observe(
                FakeMessage(13, "Раскрой №9", reply_to=10),
                "reply_search", 3, decision_code="reply_not_outgoing",
            )

            records = {record["sourceMessageId"]: record for record in audit.messages.values()}
            self.assertEqual(records["11"]["status"], "used")
            self.assertEqual(records["12"]["status"], "skipped")
            self.assertEqual(records["13"]["status"], "skipped")
            self.assertIn("отклонён", records["12"]["reasonMessage"])
            self.assertIn("отклонён", records["13"]["reasonMessage"])
            spool.close()

    async def test_reply_plan_and_terminal_outbox_boundaries_are_atomic(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "audit.sqlite3"
            spool = AuditSpool(path, allow_unsafe_path=True)
            source = FakeMessage(20, filename="layout.svg")
            audit = ScanAudit.start(spool, "-100123", date(2026, 8, 6), "77", "v1", True)
            operation_key = audit.begin_operation(
                source, "telegram_reply", replyText="Раскрой №3", replyToMessageId="20",
            )
            install_outbox_failure(spool)

            with self.assertRaisesRegex(RuntimeError, "forced outbox failure"):
                audit.finish_operation(
                    operation_key, source, "succeeded", "reply_send_succeeded", "Ответ отправлен",
                )

            saved = json.loads(spool.connection.execute(
                "SELECT operation_json FROM reply_attempts WHERE operation_key=?", (operation_key,)
            ).fetchone()[0])
            self.assertEqual(saved["status"], "planned")
            spool.close()

            reopened = AuditSpool(path, allow_unsafe_path=True)
            self.assertEqual([item["operation"]["operationKey"] for item in reopened.pending_reply_attempts()], [operation_key])
            reopened.close()

    def test_failed_planned_reply_rolls_back_ordinal_and_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spool = AuditSpool(Path(temp) / "audit.sqlite3", allow_unsafe_path=True)
            source = FakeMessage(30, filename="layout.svg")
            audit = ScanAudit.start(spool, "-100123", date(2026, 8, 6), "77", "v1", True)
            install_outbox_failure(spool)

            with self.assertRaisesRegex(RuntimeError, "forced outbox failure"):
                audit.begin_operation(
                    source, "telegram_reply", replyText="Раскрой №4", replyToMessageId="30",
                )

            self.assertEqual(spool.connection.execute("SELECT count(*) FROM operation_ordinals").fetchone()[0], 0)
            self.assertEqual(spool.connection.execute("SELECT count(*) FROM reply_attempts").fetchone()[0], 0)
            spool.close()

    async def test_observation_is_committed_per_yield_and_running_scan_is_abandoned(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "audit.sqlite3"
            spool = AuditSpool(path, allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 8, 6), "9007199254740993", "parser-v1", True)
            await audit.observe(FakeMessage(1, filename="a.svg"), "day_history", 1)
            await audit.observe(FakeMessage(2, text="комментарий"), "day_history", 2)
            rows = spool.connection.execute("SELECT payload_json FROM audit_outbox ORDER BY created_at,outbox_id").fetchall()
            observations = [item for row in rows for item in json.loads(row[0]).get("observations", [])]
            self.assertEqual([item["readOrdinal"] for item in observations], [1, 2])
            self.assertEqual(spool.abandon_running_scans(), 1)
            status = spool.connection.execute("SELECT status FROM audit_scans WHERE scan_id=?", (audit.scan["scanId"],)).fetchone()
            self.assertEqual(status[0], "abandoned")
            spool.close()

    async def test_scan_skip_and_failure_counts_follow_final_message_status_once(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spool = AuditSpool(Path(temp) / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 8, 6), "77", "v1", False)
            dxf = FakeMessage(40, filename="layout.dxf")
            reply = FakeMessage(41, text="Раскрой №7", reply_to=999)

            await audit.observe(dxf, "day_history", 1)
            audit.mark_message(dxf, "skipped", "unsupported_dxf", "DXF не поддерживается")
            audit.mark_message(dxf, "skipped", "unsupported_dxf", "DXF не поддерживается")
            self.assertEqual((audit.scan["skippedCount"], audit.scan["failedCount"]), (1, 0))

            audit.mark_message(dxf, "failed", "svg_download_failed", "Файл недоступен")
            self.assertEqual((audit.scan["skippedCount"], audit.scan["failedCount"]), (0, 1))

            await audit.observe(reply, "reply_search", 1, decision_code="reply_wrong_target")
            self.assertEqual((audit.scan["skippedCount"], audit.scan["failedCount"]), (1, 1))
            saved_scan = json.loads(spool.connection.execute(
                "SELECT scan_json FROM audit_scans WHERE scan_id=?", (audit.scan["scanId"],)
            ).fetchone()[0])
            self.assertEqual((saved_scan["skippedCount"], saved_scan["failedCount"]), (1, 1))
            spool.close()

    def test_raw_digest_distinguishes_redacted_variants_and_display_is_sanitized(self) -> None:
        first = telegram_message_record(FakeMessage(1, "password=first-secret"), "-100123", "2026-08-06")
        second = telegram_message_record(FakeMessage(1, "password=second-secret"), "-100123", "2026-08-06")
        self.assertNotEqual(first["logKey"], second["logKey"])
        self.assertEqual(first["messageText"], "password=[REDACTED]")
        self.assertEqual(second["messageText"], "password=[REDACTED]")
        self.assertEqual(sanitize_text("Bearer abc.def", 100), "Bearer [REDACTED]")

    async def test_crash_after_reply_send_is_reconciled_without_resend(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spool = AuditSpool(Path(temp) / "audit.sqlite3", allow_unsafe_path=True)
            source = FakeMessage(100, filename="layout.svg")
            audit = ScanAudit.start(spool, "-100123", date(2026, 8, 6), "9007199254740993", "v1", True)
            operation_key = audit.begin_operation(
                source,
                "telegram_reply",
                externalPacketKey="telegram:-100123:100",
                replyText="Раскрой №17",
                replyToMessageId="100",
                sessionSenderUserId="9007199254740993",
                cuttingSequenceNo=17,
            )
            planned_at = datetime.fromisoformat(audit.operations[operation_key]["plannedAt"])
            sent = FakeMessage(
                101,
                "Раскрой №17",
                reply_to=100,
                outgoing=True,
                created_at=planned_at,
            )

            reconciled = await reconcile_pending_replies(
                spool,
                FakeTelegramClient([sent]),
                object(),
                "9007199254740993",
            )

            self.assertEqual([item["operationKey"] for item in reconciled], [operation_key])
            self.assertFalse(spool.has_unresolved_reply("-100123", "100"))
            saved = json.loads(spool.connection.execute(
                "SELECT operation_json FROM reply_attempts WHERE operation_key=?",
                (operation_key,),
            ).fetchone()[0])
            self.assertEqual(saved["status"], "reconciled")
            self.assertEqual(saved["sentTelegramMessageId"], "101")
            payloads = [json.loads(row[0]) for row in spool.connection.execute(
                "SELECT payload_json FROM audit_outbox ORDER BY created_at,outbox_id"
            ).fetchall()]
            observations = [observation for payload in payloads for observation in payload.get("observations", [])]
            self.assertTrue(any(item["readSource"] == "reply_reconciliation" for item in observations))
            spool.close()

    async def test_restart_before_erp_request_terminalizes_unprepared_processing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spool = AuditSpool(Path(temp) / "audit.sqlite3", allow_unsafe_path=True)
            source = FakeMessage(90, filename="layout.svg")
            audit = ScanAudit.start(spool, "-100123", date(2026, 8, 6), "77", "v1", False)
            operation_key = audit.begin_operation(
                source, "message_processing", externalPacketKey="telegram:-100123:90",
            )

            class NeverCalledErp:
                async def ingest_packet(self, *_args: object) -> dict[str, object]:
                    raise AssertionError("unprepared ERP request must not be replayed")

            recovered = await reconcile_pending_processing_attempts(
                spool, NeverCalledErp(), object(),
            )

            self.assertEqual([item["operationKey"] for item in recovered], [operation_key])
            saved = json.loads(spool.connection.execute(
                "SELECT operation_json FROM processing_attempts WHERE operation_key=?", (operation_key,)
            ).fetchone()[0])
            self.assertEqual(saved["status"], "failed")
            self.assertEqual(saved["reasonCode"], "worker_restarted_before_scan_completion")
            spool.close()

    async def test_reconciliation_reuses_exact_per_yield_payload_after_process_death(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spool = AuditSpool(Path(temp) / "audit.sqlite3", allow_unsafe_path=True)
            source = FakeMessage(110, filename="layout.svg")
            audit = ScanAudit.start(spool, "-100123", date(2026, 8, 6), "9007199254740993", "v1", True)
            operation_key = audit.begin_operation(
                source, "telegram_reply", externalPacketKey="telegram:-100123:110",
                replyText="Раскрой №21", replyToMessageId="110",
                sessionSenderUserId="9007199254740993", cuttingSequenceNo=21,
            )
            original_operation = json.loads(json.dumps(audit.operations[operation_key]))
            planned_at = datetime.fromisoformat(original_operation["plannedAt"])
            sent = FakeMessage(
                111, "Раскрой №21", reply_to=110, outgoing=True, created_at=planned_at,
            )

            with self.assertRaises(KeyboardInterrupt):
                await reconcile_pending_replies(
                    spool, CrashAfterFirstTelegramClient([sent]), object(), "9007199254740993",
                )

            saved_planned = json.loads(spool.connection.execute(
                "SELECT operation_json FROM reply_attempts WHERE operation_key=?", (operation_key,)
            ).fetchone()[0])
            self.assertEqual(saved_planned["status"], "planned")
            self.assertIn("_reconciliationObservations", saved_planned)

            reconciled = await reconcile_pending_replies(
                spool, FakeTelegramClient([sent]), object(), "9007199254740993",
            )
            self.assertEqual([item["operationKey"] for item in reconciled], [operation_key])

            payloads = [json.loads(row[0]) for row in spool.connection.execute(
                "SELECT payload_json FROM audit_outbox ORDER BY created_at,outbox_id"
            ).fetchall()]
            yielded = [payload for payload in payloads if payload.get("observations")]
            self.assertEqual(len(yielded), 2)
            self.assertEqual(yielded[0]["observations"], yielded[1]["observations"])
            self.assertEqual(yielded[0]["messages"], yielded[1]["messages"])
            self.assertEqual(yielded[0]["operations"], [original_operation])
            self.assertEqual(yielded[1]["operations"], [original_operation])
            spool.close()

    async def test_unproven_reply_stays_blocked_after_complete_search(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spool = AuditSpool(Path(temp) / "audit.sqlite3", allow_unsafe_path=True)
            source = FakeMessage(200, filename="layout.svg")
            audit = ScanAudit.start(spool, "-100123", date(2026, 8, 6), "9007199254740993", "v1", True)
            operation_key = audit.begin_operation(
                source,
                "telegram_reply",
                externalPacketKey="telegram:-100123:200",
                replyText="Раскрой №18",
                replyToMessageId="200",
                sessionSenderUserId="9007199254740993",
                cuttingSequenceNo=18,
            )

            self.assertEqual(await reconcile_pending_replies(
                spool, FakeTelegramClient([]), object(), "9007199254740993"
            ), [])
            self.assertTrue(spool.has_unresolved_reply("-100123", "200"))
            status = spool.connection.execute(
                "SELECT status FROM reply_attempts WHERE operation_key=?", (operation_key,)
            ).fetchone()[0]
            self.assertEqual(status, "incomplete")
            spool.close()

    async def test_multiple_exact_replies_are_ambiguous_and_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            spool = AuditSpool(Path(temp) / "audit.sqlite3", allow_unsafe_path=True)
            source = FakeMessage(300, filename="layout.svg")
            audit = ScanAudit.start(spool, "-100123", date(2026, 8, 6), "9007199254740993", "v1", True)
            operation_key = audit.begin_operation(
                source,
                "telegram_reply",
                externalPacketKey="telegram:-100123:300",
                replyText="Раскрой №19",
                replyToMessageId="300",
                sessionSenderUserId="9007199254740993",
                cuttingSequenceNo=19,
            )
            planned_at = datetime.fromisoformat(audit.operations[operation_key]["plannedAt"])
            matches = [
                FakeMessage(301, "Раскрой №19", reply_to=300, outgoing=True, created_at=planned_at),
                FakeMessage(302, "Раскрой №19", reply_to=300, outgoing=True, created_at=planned_at),
            ]

            self.assertEqual(await reconcile_pending_replies(
                spool, FakeTelegramClient(matches), object(), "9007199254740993"
            ), [])
            self.assertTrue(spool.has_unresolved_reply("-100123", "300"))
            status = spool.connection.execute(
                "SELECT status FROM reply_attempts WHERE operation_key=?", (operation_key,)
            ).fetchone()[0]
            self.assertEqual(status, "ambiguous")
            spool.close()


def install_outbox_failure(spool: AuditSpool) -> None:
    spool.connection.execute("""
      CREATE TEMP TRIGGER force_audit_outbox_failure
      BEFORE INSERT ON audit_outbox
      BEGIN
        SELECT RAISE(ABORT, 'forced outbox failure');
      END
    """)


if __name__ == "__main__":
    unittest.main()
