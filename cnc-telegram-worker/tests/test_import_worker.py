from __future__ import annotations

import asyncio
import sys
import tempfile
import types
import unittest
import re
import time
from unittest.mock import AsyncMock, patch
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

telethon_stub = types.ModuleType("telethon")
telethon_stub.TelegramClient = object
telethon_stub.utils = types.SimpleNamespace(get_peer_id=lambda entity: entity)
sys.modules.setdefault("telethon", telethon_stub)

from cnc_telegram_worker.worker import (
    BoundedMediaWriter,
    CncTelegramWorker,
    WeightedQueueScheduler,
    canonical_layout_fingerprint,
    serialize_import_scan_message,
)


SVG = """
<svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 10000 5000">
  <rect id="_1234_PartContour" width="2000" height="1000" />
</svg>
"""


class File:
    def __init__(self, name: str | None, mime: str | None) -> None:
        self.name = name
        self.mime_type = mime


class Message:
    def __init__(self, message_id: int, name: str, content: str) -> None:
        self.id = message_id
        self.date = datetime(2026, 8, 18, 5, 0, tzinfo=timezone.utc)
        self.edit_date = None
        self.raw_text = ""
        self.file = File(name, "image/svg+xml")
        self.content = content

    async def download_media(self, *, file: str) -> str:
        Path(file).write_text(self.content, encoding="utf-8")
        return file


class ImportMessage:
    """Small Telethon-shaped message fixture for raw import snapshots."""

    def __init__(
        self,
        message_id: int,
        *,
        name: str | None = None,
        mime: str | None = None,
        text: str = "",
        media: bytes | str | None = None,
        photo: object | None = None,
        sender_id: int | None = None,
        date_value: datetime | None = None,
    ) -> None:
        self.id = message_id
        self.date = date_value or datetime(2026, 8, 18, 5, 0, tzinfo=timezone.utc)
        self.edit_date = None
        self.raw_text = text
        self.file = File(name, mime) if name is not None or mime is not None else None
        self.photo = photo
        self.sender_id = sender_id
        self.out = False
        self.media = media

    async def download_media(self, *, file: object) -> str:
        payload = self.media
        if payload is None:
            return ""
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        if hasattr(file, "write"):
            file.write(payload)
            return getattr(file, "name", "")
        Path(file).write_bytes(payload)
        return str(file)


class Telegram:
    def __init__(self, message: Message) -> None:
        self.message = message
        self.sent = 0

    def iter_messages(self, entity: object, **kwargs: object):
        async def iterator():
            yield self.message
        return iterator()

    async def get_messages(self, entity: object, *, ids: list[int]):
        return [self.message] if self.message.id in ids else []


class HistoryTelegram:
    def __init__(self, messages: list[ImportMessage]) -> None:
        self.messages = messages

    def iter_messages(self, entity: object, **kwargs: object):
        async def iterator():
            for message in reversed(self.messages):
                yield message

        return iterator()


class ScanErp:
    def __init__(self, task: dict[str, object]) -> None:
        self.task = task
        self.batches: list[dict[str, object]] = []
        self.completed: list[dict[str, object]] = []
        self.failed: list[dict[str, object]] = []

    async def claim_import_scans(self):
        return [self.task]

    async def submit_import_scan_candidates(self, scan_id, candidates, lease, **progress):
        self.batches.append({"scanId": scan_id, "candidates": candidates, **progress})
        return {"accepted": len(candidates)}

    async def complete_import_scan(self, scan_id, progress, lease):
        self.completed.append({"scanId": scan_id, **(progress or {})})
        return {}

    async def fail_import_scan(self, scan_id, code, message, lease):
        self.failed.append({"scanId": scan_id, "errorCode": code, "errorMessage": message})
        return {}


def make_worker(root: Path) -> CncTelegramWorker:
    worker = object.__new__(CncTelegramWorker)
    worker.config = types.SimpleNamespace(
        max_messages_per_scan=1000,
        business_timezone=types.SimpleNamespace(),
        parser_version="test-import-v1",
        svg_validation_mode="lenient",
        temp_dir=root / "tmp",
        default_machine="",
        default_material="MDF",
        ocr_engine="none",
    )
    worker.config.business_timezone = ZoneInfo("UTC")
    worker.erp = types.SimpleNamespace()
    return worker


class ImportWorkerTest(unittest.TestCase):
    def _scan_task(self, date_from: str, date_to: str) -> dict[str, object]:
        return {
            "scanId": "scan-1",
            "sourceChatId": "-100",
            "dateFrom": date_from,
            "dateTo": date_to,
            "itemLeaseToken": "t" * 32,
            "itemLeaseGeneration": 1,
            "itemLeaseOwner": "00000000-0000-4000-8000-000000000001",
        }

    def test_multi_day_scan_uses_one_claim_and_completes_after_every_day(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root_name:
                worker = make_worker(Path(root_name))
                erp = ScanErp(self._scan_task("2026-08-12", "2026-08-18"))
                worker.erp = erp
                await worker.process_import_scan_queue(Telegram(Message(42, "part.svg", SVG)), object(), "-100")
                self.assertEqual(len(erp.batches), 7)
                self.assertEqual(len(erp.completed), 1)
                self.assertEqual(erp.completed[0]["daysScanned"], 7)
                self.assertEqual([batch["days_scanned"] for batch in erp.batches], list(range(1, 8)))
                self.assertEqual(erp.failed, [])

        asyncio.run(scenario())

    def test_scan_submits_raw_messages_even_when_candidate_list_is_empty(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root_name:
                worker = make_worker(Path(root_name))
                erp = ScanErp(self._scan_task("2026-08-18", "2026-08-18"))
                worker.erp = erp
                telegram = HistoryTelegram([
                    ImportMessage(51, text="обычное сообщение"),
                    ImportMessage(52, mime="image/png", media=b"image", photo=object()),
                ])
                await worker.process_import_scan_queue(telegram, object(), "-100")
                self.assertEqual(len(erp.batches), 1)
                self.assertEqual(erp.batches[0]["candidates"], [])
                self.assertEqual(
                    [row["sourceMessageId"] for row in erp.batches[0]["messages"]],
                    ["51", "52"],
                )
                self.assertEqual(erp.completed[0]["messagesScanned"], 2)

        asyncio.run(scenario())

    def test_scan_supports_more_than_one_thousand_messages_in_one_atomic_day_batch(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root_name:
                worker = make_worker(Path(root_name))
                erp = ScanErp(self._scan_task("2026-08-18", "2026-08-18"))
                worker.erp = erp
                raw_messages = [{"sourceMessageId": str(message_id)} for message_id in range(1, 1501)]
                worker.discover_workday = AsyncMock(return_value=([], {
                    "messagesProcessed": 1500,
                    "candidatesFound": 0,
                    "warningsCount": 0,
                    "truncated": False,
                    "messages": raw_messages,
                }))

                await worker.process_import_scan_queue(object(), object(), "-100")

                self.assertEqual(worker.discover_workday.await_args.kwargs["max_messages"], 5000)
                self.assertEqual(len(erp.batches), 1)
                self.assertEqual(len(erp.batches[0]["messages"]), 1500)
                self.assertEqual(erp.batches[0]["days_scanned"], 1)
                self.assertFalse(erp.batches[0]["truncated"])

        asyncio.run(scenario())

    def test_thirty_one_day_scan_stays_bounded(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root_name:
                worker = make_worker(Path(root_name))
                erp = ScanErp(self._scan_task("2026-08-01", "2026-08-31"))
                worker.erp = erp
                await worker.process_import_scan_queue(Telegram(Message(42, "part.svg", SVG)), object(), "-100")
                self.assertEqual(len(erp.batches), 31)
                self.assertEqual(erp.completed[0]["daysScanned"], 31)
                self.assertLessEqual(max(int(batch["messages_scanned"]) for batch in erp.batches), 5000)

        asyncio.run(scenario())

    def test_scan_range_over_thirty_one_days_fails_closed(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root_name:
                worker = make_worker(Path(root_name))
                erp = ScanErp(self._scan_task("2026-08-01", "2026-09-01"))
                worker.erp = erp
                await worker.process_import_scan_queue(Telegram(Message(42, "part.svg", SVG)), object(), "-100")
                self.assertEqual(erp.batches, [])
                self.assertEqual(erp.completed, [])
                self.assertEqual(erp.failed[0]["errorCode"], "DISCOVERY_FAILED")

        asyncio.run(scenario())

    def test_scheduler_bounds_continuous_manual_backlog(self) -> None:
        scheduler = WeightedQueueScheduler()
        now = 100.0
        ready = {"manual": True, "import": True, "restore": True, "discovery": True}
        selected = [scheduler.choose(ready, {name: now for name in ready}, now) for _ in range(8)]
        self.assertEqual(selected[:4], ["manual"] * 4)
        self.assertIn("import", selected[4:])
        self.assertIn("restore", selected[4:])

    def test_scheduler_uses_persistent_ready_since_for_aging(self) -> None:
        scheduler = WeightedQueueScheduler(aging_seconds=60)
        ready = {"manual": True, "import": True, "restore": False, "discovery": False}
        ready_since = {"manual": 0.0, "import": 0.0}
        self.assertEqual(scheduler.choose(ready, ready_since, 61.0), "manual")
        self.assertEqual(ready_since["manual"], 61.0)
        ready["manual"] = False
        ready_since.pop("manual")
        self.assertEqual(scheduler.choose(ready, ready_since, 62.0), "import")

    def test_scheduler_does_not_reselect_one_aged_queue_forever(self) -> None:
        scheduler = WeightedQueueScheduler(aging_seconds=60)
        ready = {name: True for name in ("manual", "import", "restore", "discovery")}
        ready_since = {name: 0.0 for name in ready}
        selected = [scheduler.choose(ready, ready_since, 61.0 + index) for index in range(4)]
        self.assertEqual(selected, ["manual", "import", "restore", "discovery"])

    def test_empty_manual_does_not_delay_ready_import(self) -> None:
        async def scenario() -> None:
            worker = object.__new__(CncTelegramWorker)
            worker.config = types.SimpleNamespace(
                can_send_manual_svg_uploads=True,
                poll_interval_seconds=0.05,
            )
            stop_event = asyncio.Event()
            worker.process_manual_svg_telegram_send_requests = AsyncMock(return_value=0)

            async def import_once(*args: object, **kwargs: object) -> int:
                stop_event.set()
                return 1

            worker.process_import_item_queue = AsyncMock(side_effect=import_once)
            worker.process_media_restore_requests = AsyncMock(return_value=0)
            worker.process_import_scan_queue = AsyncMock(return_value=0)
            await asyncio.wait_for(
                worker.poll_queue_scheduler(object(), object(), "-100", stop_event),
                timeout=0.5,
            )
            self.assertEqual(worker.process_manual_svg_telegram_send_requests.call_count, 1)
            self.assertEqual(worker.process_import_item_queue.call_count, 1)

        asyncio.run(scenario())

    def test_all_empty_scheduler_queues_are_polled_with_interval(self) -> None:
        async def scenario() -> None:
            worker = object.__new__(CncTelegramWorker)
            worker.config = types.SimpleNamespace(
                can_send_manual_svg_uploads=True,
                poll_interval_seconds=0.05,
            )
            worker.process_manual_svg_telegram_send_requests = AsyncMock(return_value=0)
            worker.process_import_item_queue = AsyncMock(return_value=0)
            worker.process_media_restore_requests = AsyncMock(return_value=0)
            worker.process_import_scan_queue = AsyncMock(return_value=0)
            stop_event = asyncio.Event()
            task = asyncio.create_task(
                worker.poll_queue_scheduler(object(), object(), "-100", stop_event),
            )
            await asyncio.sleep(0.08)
            stop_event.set()
            await asyncio.wait_for(task, timeout=0.5)
            total_calls = sum(
                method.call_count
                for method in (
                    worker.process_manual_svg_telegram_send_requests,
                    worker.process_import_item_queue,
                    worker.process_media_restore_requests,
                    worker.process_import_scan_queue,
                )
            )
            # Four queues are probed immediately once and once after the
            # 50ms cooldown; a zero-delay loop would be orders of magnitude
            # larger than this bound.
            self.assertLessEqual(total_calls, 8)

        asyncio.run(scenario())

    def test_import_cooldown_is_short_without_changing_manual_restore_polling(self) -> None:
        async def scenario() -> None:
            worker = object.__new__(CncTelegramWorker)
            worker.config = types.SimpleNamespace(
                can_send_manual_svg_uploads=False,
                poll_interval_seconds=60,
                # Test value keeps the regression fast; production default is 5s.
                import_queue_poll_interval_seconds=0.05,
            )
            stop_event = asyncio.Event()
            import_calls: list[float] = []

            async def import_once(*args: object, **kwargs: object) -> int:
                import_calls.append(time.monotonic())
                if len(import_calls) == 2:
                    stop_event.set()
                return 0

            worker.process_manual_svg_telegram_send_requests = AsyncMock(return_value=0)
            worker.process_import_item_queue = AsyncMock(side_effect=import_once)
            worker.process_media_restore_requests = AsyncMock(return_value=0)
            worker.process_import_scan_queue = AsyncMock(return_value=0)
            await asyncio.wait_for(
                worker.poll_queue_scheduler(object(), object(), "-100", stop_event),
                timeout=0.5,
            )

            self.assertEqual(len(import_calls), 2)
            self.assertGreaterEqual(import_calls[1] - import_calls[0], 0.04)
            # With the old global 60s cooldown this assertion would time out;
            # manual/restore still retain that old interval.
            self.assertLess(import_calls[1] - import_calls[0], 0.5)
            self.assertEqual(worker.process_manual_svg_telegram_send_requests.call_count, 0)

        asyncio.run(scenario())

    def test_bounded_media_writer_rejects_before_writing_over_limit(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            target = Path(root_name) / "file.svg"
            writer = BoundedMediaWriter(target, 3)
            try:
                self.assertEqual(writer.write(b"abc"), 3)
                with self.assertRaisesRegex(ValueError, "exceeds"):
                    writer.write(b"d")
            finally:
                writer.close()
            self.assertEqual(target.read_bytes(), b"abc")

    def test_manual_send_processes_one_claimed_operation_per_turn(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root_name:
                worker = make_worker(Path(root_name))
                worker.config.can_send_manual_svg_uploads = True
                worker.config.can_write_chat = True
                worker.config.business_timezone = ZoneInfo("UTC")
                task = {
                    "requestId": "00000000-0000-4000-8000-000000000010",
                    "cutJobDisplayNumber": "123",
                    "messageText": "",
                    "itemLeaseToken": "i" * 64,
                    "itemLeaseGeneration": 1,
                    "itemLeaseOwner": "00000000-0000-4000-8000-000000000001",
                    "files": [{"kind": "svg", "fileName": "part.svg"}],
                }

                class Erp:
                    async def claim_manual_svg_telegram_sends(self):
                        return {"capability": "cnc_manual_svg_telegram_send_v1", "tasks": [task, dict(task, requestId="00000000-0000-4000-8000-000000000011")]}

                    async def complete_manual_svg_telegram_send(self, *args):
                        return {}

                    async def fail_manual_svg_telegram_send(self, *args):
                        return {}

                worker.erp = Erp()
                output = Path(root_name) / "part.svg"
                output.write_text("<svg/>", encoding="utf-8")
                with patch("cnc_telegram_worker.worker.write_manual_svg_send_file", return_value=output), patch(
                    "cnc_telegram_worker.worker.send_manual_svg_upload_files", new=AsyncMock(return_value=[])
                ):
                    processed = await worker.process_manual_svg_telegram_send_requests(object(), object(), "-100")
                self.assertEqual(processed, 1)

        asyncio.run(scenario())

    def test_discovery_has_no_erp_or_telegram_send_side_effect(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root_name:
                root = Path(root_name)
                worker = make_worker(root)
                telegram = Telegram(Message(42, "part.svg", SVG))
                candidates, progress = await worker.discover_workday(
                    telegram, object(), "-100", date(2026, 8, 18),
                )
                self.assertEqual(len(candidates), 1)
                self.assertEqual(candidates[0]["sourceMessageId"], "42")
                self.assertEqual(candidates[0]["eligibilityStatus"], "valid")
                self.assertRegex(candidates[0]["sourceSetFingerprint"], r"^[0-9a-f]{64}$")
                self.assertRegex(candidates[0]["layoutFingerprint"], r"^[0-9a-f]{64}$")
                self.assertEqual(progress["candidatesFound"], 1)
                self.assertEqual(telegram.sent, 0)

        asyncio.run(scenario())

    def test_discovery_persists_all_messages_and_candidate_roles(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root_name:
                root = Path(root_name)
                worker = make_worker(root)
                image = ImportMessage(
                    10,
                    mime="image/png",
                    text="Заказ 1234",
                    media=b"fake-png",
                    photo=object(),
                    sender_id=101,
                )
                svg = ImportMessage(11, name="1234.svg", mime="image/svg+xml", media=SVG)
                gcode = ImportMessage(12, name="1234.gcode", mime="text/plain", media="G1 X1 Y1")
                comment = ImportMessage(13, text="MDF 16 мм")
                unrelated = ImportMessage(
                    20,
                    text="Сообщение вне комплекта",
                    date_value=datetime(2026, 8, 18, 10, 0, tzinfo=timezone.utc),
                )

                candidates, progress = await worker.discover_workday(
                    HistoryTelegram([image, svg, gcode, comment, unrelated]),
                    object(),
                    "-100",
                    date(2026, 8, 18),
                )

                self.assertEqual(len(candidates), 1)
                self.assertEqual(progress["messagesProcessed"], 5)
                messages = progress["messages"]
                self.assertEqual([row["sourceMessageId"] for row in messages], ["10", "11", "12", "13", "20"])
                by_id = {row["sourceMessageId"]: row for row in messages}
                self.assertEqual(by_id["10"]["messageType"], "image")
                self.assertIsNone(by_id["10"]["filename"])
                self.assertEqual(by_id["10"]["mimeType"], "image/png")
                self.assertEqual(by_id["10"]["candidateSourceMessageId"], "11")
                self.assertEqual(by_id["10"]["candidateRole"], "screenshot")
                self.assertEqual(by_id["11"]["candidateRole"], "svg")
                self.assertEqual(by_id["12"]["candidateRole"], "gcode")
                self.assertEqual(by_id["13"]["candidateRole"], "comment")
                self.assertNotIn("candidateSourceMessageId", by_id["20"])
                self.assertNotIn("candidateRole", by_id["20"])

        asyncio.run(scenario())

    def test_discovery_with_no_candidates_still_returns_unrelated_messages(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root_name:
                worker = make_worker(Path(root_name))
                messages = [
                    ImportMessage(31, text="Обычный текст"),
                    ImportMessage(32, mime="image/jpeg", media=b"fake-jpeg", photo=object()),
                ]
                candidates, progress = await worker.discover_workday(
                    HistoryTelegram(messages), object(), "-100", date(2026, 8, 18),
                )
                self.assertEqual(candidates, [])
                self.assertEqual(progress["candidatesFound"], 0)
                self.assertEqual(progress["messagesProcessed"], 2)
                self.assertEqual([row["sourceMessageId"] for row in progress["messages"]], ["31", "32"])
                self.assertEqual(progress["messages"][1]["messageType"], "image")
                self.assertIsNone(progress["messages"][1]["filename"])

        asyncio.run(scenario())

    def test_raw_message_serializer_preserves_text_and_time_without_media_name(self) -> None:
        message = ImportMessage(
            99,
            mime="image/jpeg",
            text="Подпись скрина",
            photo=object(),
            sender_id=123,
        )
        row = serialize_import_scan_message(
            message,
            "-100",
            date(2026, 8, 18),
            7,
            {},
        )
        self.assertEqual(row["sourceMessageId"], "99")
        self.assertEqual(row["sourceCreatedAt"], "2026-08-18T05:00:00+00:00")
        self.assertEqual(row["messageText"], "Подпись скрина")
        self.assertEqual(row["messageType"], "image")
        self.assertIsNone(row["filename"])
        self.assertEqual(row["readOrdinal"], 7)
        self.assertEqual(row["senderUserId"], "123")

    def test_raw_message_serializer_omits_invalid_non_positive_sender_id(self) -> None:
        row = serialize_import_scan_message(
            ImportMessage(100, sender_id=-100),
            "-100",
            date(2026, 8, 18),
            1,
            {},
        )
        self.assertIsNone(row["senderUserId"])

    def test_import_rejects_changed_source_before_completion_payload(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root_name:
                root = Path(root_name)
                worker = make_worker(root)
                telegram = Telegram(Message(42, "part.svg", SVG))
                candidates, _ = await worker.discover_workday(
                    telegram, object(), "-100", date(2026, 8, 18),
                )
                telegram.message.content = SVG.replace("2000", "2100")
                with self.assertRaises(RuntimeError):
                    await worker.import_candidate(telegram, object(), "-100", {"candidate": candidates[0]})

        asyncio.run(scenario())

    def test_import_completion_contains_only_revalidated_source_contract(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root_name:
                root = Path(root_name)
                worker = make_worker(root)
                telegram = Telegram(Message(42, "part.svg", SVG))
                worker.config.business_timezone = ZoneInfo("Asia/Almaty")
                telegram.message.date = datetime(2026, 8, 17, 20, 0, tzinfo=timezone.utc)
                candidates, _ = await worker.discover_workday(telegram, object(), "-100", date(2026, 8, 18))
                self.assertEqual(candidates[0]["workday"], "2026-08-18")
                self.assertEqual(candidates[0]["sourceCreatedAt"], "2026-08-17T20:00:00+00:00")
                result = await worker.import_candidate(telegram, object(), "-100", {"candidate": candidates[0]})
                self.assertEqual(set(result), {"sourceSetFingerprint", "source", "sourceFiles"})
                self.assertEqual(result["source"]["sourceMessageId"], "42")
                self.assertNotIn("packetId", result["source"])
                self.assertEqual(len(result["sourceFiles"]), 1)
                self.assertEqual(result["sourceFiles"][0]["sizeBytes"], len(SVG.encode()))
                self.assertEqual(len(result["sourceFiles"][0]["base64Content"]), ((len(SVG.encode()) + 2) // 3) * 4)

        asyncio.run(scenario())

    def test_fingerprints_are_bare_sha256_and_geometry_is_label_independent(self) -> None:
        first = {
            "material": "MDF 16mm",
            "sheet": {"widthMm": 1000, "heightMm": 500},
            "items": [{
                "orderName": "1234", "detailNumber": 7, "sourceElementId": "label-a",
                "widthMm": 200, "heightMm": 100, "xMm": 12.34567, "yMm": 20.1254,
                "placedWidthMm": 200, "placedHeightMm": 100, "rotated": False,
            }],
        }
        renamed = {
            "material": "MDF 16mm",
            "sheet": {"widthMm": 1000, "heightMm": 500},
            "items": [{
                "orderName": "9999", "detailNumber": 99, "sourceElementId": "different-label",
                "widthMm": 200, "heightMm": 100, "xMm": 12.3456, "yMm": 20.12549,
                "placedWidthMm": 200, "placedHeightMm": 100, "rotated": False,
            }],
        }
        moved = {**renamed, "items": [{**renamed["items"][0], "xMm": 13.0}]}
        first_hash = canonical_layout_fingerprint(first)
        self.assertIsNotNone(first_hash)
        self.assertRegex(first_hash or "", re.compile(r"^[0-9a-f]{64}$"))
        self.assertEqual(first_hash, canonical_layout_fingerprint(renamed))
        self.assertNotEqual(first_hash, canonical_layout_fingerprint(moved))

    def test_layout_fingerprint_matches_typescript_golden_fixture(self) -> None:
        layout = {
            "material": "ignored-by-contract",
            "sheet": {"widthMm": 2800, "heightMm": 2070},
            "items": [{
                "widthMm": 100.1234,
                "heightMm": 200.5678,
                "xMm": 10,
                "yMm": 20,
                "placedWidthMm": 100.1234,
                "placedHeightMm": 200.5678,
                "rotated": False,
                "quantity": 1,
            }],
        }
        self.assertEqual(
            canonical_layout_fingerprint(layout),
            "808a9b6c7f81e3746ba7139ee7fcc9aa997c88bedacf97fc8b02634baab14bcc",
        )
