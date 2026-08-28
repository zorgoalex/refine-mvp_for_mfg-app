from __future__ import annotations

import asyncio
import unittest
import json
import httpx
import sys
import tempfile
import types
from dataclasses import replace
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, call, patch

telethon_stub = types.ModuleType("telethon")
telethon_stub.TelegramClient = object
telethon_stub.utils = types.SimpleNamespace(get_peer_id=lambda entity: entity)
sys.modules.setdefault("telethon", telethon_stub)

from cnc_telegram_worker.telegram_source import collect_day_messages, is_image_message, is_vector_message
from cnc_telegram_worker.audit import (
    AuditSpool,
    ScanAudit,
    reconcile_pending_processing_attempts,
    reconcile_pending_replies,
)
from cnc_telegram_worker.packet import external_packet_key
from cnc_telegram_worker.ocr import OcrResult
from cnc_telegram_worker.state import StateStore
from cnc_telegram_worker.worker import (
    CncTelegramWorker,
    SvgGroup,
    apply_cutting_sequence_reply_index,
    apply_known_cutting_sequence_state,
    assert_allowed_chat,
    collect_cutting_sequence_reply_search_index,
    cutting_sequence_reply_number,
    group_has_thumbs_up,
    group_svg_messages,
    group_source_fingerprint,
    is_cutting_sequence_reply_text,
    parse_cutting_sequence_reply,
)
from cnc_telegram_worker.erp_client import ErpResponseError, WorkerSessionLease


VALID_SVG = """
<svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 10000 5000">
  <rect id="_1234_PartContour" width="2000" height="1000">
    <metadata><odm name="Comments" value="1234#7#X@200*100@"/></metadata>
  </rect>
</svg>
"""


class FakeFile:
    def __init__(self, name: str | None, mime_type: str | None = None) -> None:
        self.name = name
        self.mime_type = mime_type


class FakeReaction:
    def __init__(self, emoticon: str) -> None:
        self.emoticon = emoticon


class FakeReactionResult:
    def __init__(self, emoticon: str, count: int = 1) -> None:
        self.reaction = FakeReaction(emoticon)
        self.count = count


class FakeMessage:
    def __init__(
        self,
        message_id: int,
        *,
        text: str = "",
        filename: str | None = None,
        mime_type: str | None = None,
        thumbs_up: bool = False,
        reply_to: int | None = None,
        media_content: str | None = None,
    ) -> None:
        self.id = message_id
        self.date = datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc)
        self.edit_date = None
        self.raw_text = text
        self.file = FakeFile(filename, mime_type) if filename or mime_type else None
        self.reply_to = types.SimpleNamespace(reply_to_msg_id=reply_to) if reply_to else None
        self.reactions = (
            types.SimpleNamespace(results=[FakeReactionResult("\U0001F44D")])
            if thumbs_up
            else None
        )
        self.media_content = media_content

    async def download_media(self, *, file: str) -> str | None:
        if self.media_content is None:
            return None
        Path(file).write_text(self.media_content, encoding="utf-8")
        return file


class FailingDownloadMessage(FakeMessage):
    async def download_media(self, *, file: str) -> str | None:
        raise OSError("Telegram media download failed")


class FakeTelegramClient:
    def __init__(self, messages: list[FakeMessage]) -> None:
        self.messages = messages
        self.iter_messages_calls: list[dict[str, object]] = []
        self.sent_messages: list[dict[str, object]] = []

    def iter_messages(self, entity: object, **kwargs: object):
        self.iter_messages_calls.append(kwargs)
        return self._iter_messages()

    async def _iter_messages(self):
        for message in self.messages:
            yield message

    async def send_message(self, entity: object, text: str, *, reply_to: int) -> None:
        self.sent_messages.append({"entity": entity, "text": text, "reply_to": reply_to})


class SearchMissTelegramClient(FakeTelegramClient):
    def iter_messages(self, entity: object, **kwargs: object):
        self.iter_messages_calls.append(kwargs)
        return self._empty() if kwargs.get("search") else self._iter_messages()

    async def _empty(self):
        if False:
            yield None


class FakeErpClient:
    def __init__(self) -> None:
        self.packets: list[dict[str, object]] = []
        self.audit_batches: list[dict[str, object]] = []

    async def ingest_packet(self, packet: dict[str, object], idempotency_key: str) -> dict[str, object]:
        self.packets.append(packet)
        return {"applied": True, "packet": {"cuttingSequenceNo": 12, "svgCutImportStatus": "imported"}}

    async def audit_batch(self, payload: dict[str, object]) -> None:
        self.audit_batches.append(payload)


class FailingErpClient(FakeErpClient):
    async def ingest_packet(self, packet: dict[str, object], idempotency_key: str) -> dict[str, object]:
        self.packets.append(packet)
        raise RuntimeError("ERP unavailable")


class BackendRejectedError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("ERP rejected packet with 422")
        self.response = types.SimpleNamespace(status_code=422)


class RejectingErpClient(FakeErpClient):
    async def ingest_packet(self, packet: dict[str, object], idempotency_key: str) -> dict[str, object]:
        self.packets.append(packet)
        raise BackendRejectedError()


class SkippedDuplicateErpClient(FakeErpClient):
    async def ingest_packet(self, packet: dict[str, object], idempotency_key: str) -> dict[str, object]:
        self.packets.append(packet)
        return {
            "applied": False,
            "packet": {
                "packetId": "existing-packet",
                "cuttingSequenceNo": 44,
                "svgCutImportStatus": "imported",
                "svgCutJobId": 98,
            },
            "skippedDuplicateSourceFile": {
                "status": "skipped",
                "sha256": "b" * 64,
                "fileName": "CNC#1_1234.svg",
                "cutJobId": 98,
                "cutJobDisplayNumber": "104",
                "cutResultId": 500,
                "packetId": "existing-packet",
                "note": "SVG-файл уже есть в задании на раскрой №104",
            },
        }


class FailingTelegramClient(FakeTelegramClient):
    async def send_message(self, entity: object, text: str, *, reply_to: int) -> None:
        raise RuntimeError("Telegram send failed")


class CrashAfterAcceptErpClient(FakeErpClient):
    async def ingest_packet(self, packet: dict[str, object], idempotency_key: str) -> dict[str, object]:
        self.packets.append(packet)
        raise KeyboardInterrupt("simulated process death after ERP accepted the packet")


class WorkerFingerprintTest(unittest.TestCase):
    def test_group_source_fingerprint_tracks_parser_and_comments(self) -> None:
        group = SvgGroup(
            vector_message=FakeMessage(12, filename="2689.svg"),
            image_message=FakeMessage(10, text="2689"),
            comments=["2689 весь"],
            cutting_sequence_no=None,
            gcode_message=FakeMessage(11, filename="CNC#1_2689.TXT"),
        )

        first = group_source_fingerprint(group, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a")
        self.assertEqual(
            first,
            group_source_fingerprint(group, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a"),
        )
        self.assertNotEqual(
            first,
            group_source_fingerprint(group, "-100123", date(2026, 7, 24), "parser-v2", "ocr-a"),
        )
        changed_comment = SvgGroup(
            vector_message=group.vector_message,
            image_message=group.image_message,
            comments=["2689 весь", "ХДФ"],
            cutting_sequence_no=None,
            gcode_message=group.gcode_message,
        )
        self.assertNotEqual(
            first,
            group_source_fingerprint(changed_comment, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a"),
        )

    def test_group_source_fingerprint_ignores_screenshot_identity(self) -> None:
        group = SvgGroup(
            vector_message=FakeMessage(12, filename="CNC#1_2689.svg"),
            image_message=FakeMessage(10, text="2689"),
            comments=["2689 весь"],
            cutting_sequence_no=None,
            gcode_message=FakeMessage(11, filename="CNC#1_2689.TXT"),
        )
        changed_image = SvgGroup(
            vector_message=group.vector_message,
            image_message=FakeMessage(13, text="2689"),
            comments=group.comments,
            cutting_sequence_no=None,
            gcode_message=group.gcode_message,
        )

        self.assertEqual(
            group_source_fingerprint(group, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a"),
            group_source_fingerprint(changed_image, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a"),
        )

    def test_svg_attachment_is_vector_not_sheet_image(self) -> None:
        message = FakeMessage(20, filename="2689.svg", mime_type="image/svg+xml")

        self.assertFalse(is_image_message(message))
        self.assertTrue(is_vector_message(message))

    def test_groups_nearest_vector_attachment_with_image(self) -> None:
        image = FakeMessage(30, text="2689", filename="sheet.jpg", mime_type="image/jpeg")
        gcode = FakeMessage(31, filename="CNC#1_2689.TXT")
        vector = FakeMessage(32, filename="CNC#1_2689.svg", mime_type="image/svg+xml")

        groups = group_svg_messages([image, gcode, vector])

        self.assertEqual(len(groups), 1)
        self.assertIs(groups[0].source_message, vector)
        self.assertIs(groups[0].image_message, image)
        self.assertIs(groups[0].gcode_message, gcode)
        self.assertIs(groups[0].vector_message, vector)

    def test_svg_and_gcode_names_must_match_before_extension(self) -> None:
        image = FakeMessage(30, text="2689", filename="sheet.jpg", mime_type="image/jpeg")
        gcode = FakeMessage(31, filename="CNC#1_2689.TXT")
        vector = FakeMessage(32, filename="2689.svg", mime_type="image/svg+xml")

        groups = group_svg_messages([image, gcode, vector])

        self.assertEqual(len(groups), 1)
        self.assertIs(groups[0].source_message, vector)
        self.assertIs(groups[0].image_message, image)
        self.assertIsNone(groups[0].gcode_message)
        self.assertIs(groups[0].vector_message, vector)

    def test_svg_and_gcode_names_match_cyrillic_filename_lookalikes_only(self) -> None:
        gcode = FakeMessage(11143, filename="CNC#1_2812-8ММ.TXT")
        vector = FakeMessage(11144, filename="CNC#1_2812-8MM.svg", mime_type="image/svg+xml")

        groups = group_svg_messages([gcode, vector])

        self.assertEqual(len(groups), 1)
        self.assertIs(groups[0].gcode_message, gcode)

        unrelated = group_svg_messages([
            FakeMessage(11143, filename="CNC#1_2813-8ММ.TXT"),
            vector,
        ])
        self.assertEqual(len(unrelated), 1)
        self.assertIsNone(unrelated[0].gcode_message)

    def test_svg_and_gcode_exact_basename_match_is_preferred(self) -> None:
        exact = FakeMessage(11143, filename="CNC#1_2812-8MM.TXT")
        confusable = FakeMessage(11144, filename="CNC#1_2812-8ММ.TXT")
        vector = FakeMessage(11145, filename="CNC#1_2812-8MM.svg", mime_type="image/svg+xml")

        groups = group_svg_messages([exact, confusable, vector])

        self.assertEqual(len(groups), 1)
        self.assertIs(groups[0].gcode_message, exact)

    def test_svg_and_gcode_confusable_collision_does_not_attach(self) -> None:
        first = FakeMessage(11143, filename="CNC#1_2812-8MM.TXT")
        second = FakeMessage(11144, filename="CNC#1_2812-8МM.TXT")
        vector = FakeMessage(11145, filename="CNC#1_2812-8ММ.svg", mime_type="image/svg+xml")

        groups = group_svg_messages([first, second, vector])

        self.assertEqual(len(groups), 1)
        self.assertIsNone(groups[0].gcode_message)

    def test_standalone_svg_creates_group_without_image(self) -> None:
        gcode = FakeMessage(70, filename="CNC#1_2700.TXT")
        vector = FakeMessage(71, filename="CNC#1_2700.svg", mime_type="image/svg+xml")

        groups = group_svg_messages([gcode, vector])

        self.assertEqual(len(groups), 1)
        self.assertIs(groups[0].source_message, vector)
        self.assertIsNone(groups[0].image_message)
        self.assertIs(groups[0].gcode_message, gcode)

    def test_image_without_svg_does_not_create_group(self) -> None:
        image = FakeMessage(80, filename="sheet.jpg", mime_type="image/jpeg")
        gcode = FakeMessage(81, filename="CNC#1_2700.TXT")

        self.assertEqual(group_svg_messages([image, gcode]), [])

    def test_each_svg_creates_separate_group(self) -> None:
        image = FakeMessage(90, text="2700", filename="sheet.jpg", mime_type="image/jpeg")
        gcode = FakeMessage(91, filename="CNC#1_2700.TXT")
        first_svg = FakeMessage(92, filename="CNC#1_2700-a.svg", mime_type="image/svg+xml")
        second_svg = FakeMessage(93, filename="CNC#1_2700-b.svg", mime_type="image/svg+xml")

        groups = group_svg_messages([image, gcode, first_svg, second_svg])

        self.assertEqual(len(groups), 2)
        self.assertIs(groups[0].vector_message, first_svg)
        self.assertIs(groups[0].source_message, first_svg)
        self.assertIs(groups[1].vector_message, second_svg)
        self.assertIs(groups[1].source_message, second_svg)

    def test_dxf_and_screenshot_do_not_create_group(self) -> None:
        image = FakeMessage(95, filename="sheet.jpg", mime_type="image/jpeg")
        dxf = FakeMessage(96, filename="sheet.dxf")

        self.assertEqual(group_svg_messages([image, dxf]), [])

    def test_groups_file_attachments_with_previous_image_block(self) -> None:
        first_gcode = FakeMessage(10611, filename="CNC#1_2718.TXT")
        first_vector = FakeMessage(10612, filename="CNC#1_2718.svg", mime_type="image/svg+xml")
        first_image = FakeMessage(10613, text="2718", mime_type="image/jpeg")
        second_gcode = FakeMessage(10614, filename="CNC#2_2718.TXT")
        second_vector = FakeMessage(10615, filename="CNC#2_2718.svg", mime_type="image/svg+xml")
        second_image = FakeMessage(10616, text="2718", mime_type="image/jpeg")

        groups = group_svg_messages([
            first_gcode,
            first_vector,
            first_image,
            second_gcode,
            second_vector,
            second_image,
        ])

        self.assertEqual(len(groups), 2)
        self.assertIs(groups[0].gcode_message, first_gcode)
        self.assertIs(groups[0].vector_message, first_vector)
        self.assertIs(groups[1].gcode_message, second_gcode)
        self.assertIs(groups[1].vector_message, second_vector)

    def test_group_thumbs_up_uses_attachment_reactions(self) -> None:
        image = FakeMessage(40, text="2718", mime_type="image/jpeg")
        gcode = FakeMessage(41, filename="CNC#2_2718.TXT", thumbs_up=True)
        group = SvgGroup(
            vector_message=FakeMessage(42, filename="CNC#2_2718.svg"),
            image_message=image,
            comments=[],
            cutting_sequence_no=None,
            gcode_message=gcode,
        )
        without_reaction = SvgGroup(
            vector_message=group.vector_message,
            image_message=image,
            comments=[],
            cutting_sequence_no=None,
            gcode_message=FakeMessage(41, filename="CNC#2_2718.TXT"),
        )

        self.assertTrue(group_has_thumbs_up(group))
        self.assertNotEqual(
            group_source_fingerprint(group, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a"),
            group_source_fingerprint(without_reaction, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a"),
        )

    def test_cutting_sequence_reply_is_bound_to_svg_and_not_image_or_comment(self) -> None:
        image = FakeMessage(50, text="2700", mime_type="image/jpeg")
        image_reply = FakeMessage(51, text="Раскрой №99", reply_to=50)
        comment = FakeMessage(52, text="2700 весь")
        vector = FakeMessage(53, filename="2700.svg", mime_type="image/svg+xml")
        svg_reply = FakeMessage(54, text="Раскрой №7", reply_to=53)

        groups = group_svg_messages([image, image_reply, comment, vector, svg_reply])

        self.assertEqual(parse_cutting_sequence_reply("Раскрой №7"), 7)
        self.assertTrue(is_cutting_sequence_reply_text("Раскрой №7"))
        self.assertEqual(cutting_sequence_reply_number([vector, svg_reply], vector), 7)
        self.assertEqual(groups[0].cutting_sequence_no, 7)
        self.assertEqual(groups[0].comments, ["2700 весь"])


class WorkerDayHistoryTest(unittest.IsolatedAsyncioTestCase):
    async def test_observer_never_records_previous_workday_boundary_message(self) -> None:
        current = FakeMessage(101, text="current")
        current.date = datetime(2026, 7, 24, 12, 0, tzinfo=timezone.utc)
        previous = FakeMessage(100, text="previous")
        previous.date = datetime(2026, 7, 23, 23, 59, tzinfo=timezone.utc)
        observed: list[tuple[int, int]] = []

        async def observe(message: FakeMessage, ordinal: int) -> None:
            observed.append((int(message.id), ordinal))

        messages = await collect_day_messages(
            FakeTelegramClient([current, previous]),
            object(),
            date(2026, 7, 24),
            timezone.utc,
            100,
            observer=observe,
        )

        self.assertEqual([message.id for message in messages], [101])
        self.assertEqual(observed, [(101, 1)])


class WorkerServeSafetyTest(unittest.IsolatedAsyncioTestCase):
    async def test_unauthorized_telegram_session_never_claims_worker_lease(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp))
            worker.config.enabled = True
            worker.config.stack_env = "test"
            worker.config.worker_role = "reader"
            worker.config.telegram_session_path = Path(temp) / "session"
            worker.config.telegram_api_id = 1
            worker.config.telegram_api_hash = "hash"
            worker.config.telegram_chat = "-100"
            worker.config.telegram_allowed_chat_ids = ("-100",)
            worker.config.erp_bearer_token = "token"
            worker.config.erp_worker_login = ""
            worker.config.erp_worker_password = ""
            worker.config.audit_spool_path = Path(temp) / "audit.sqlite3"
            worker.config.audit_allow_unsafe_path = True
            worker.config.temp_ttl_hours = 1
            worker.config.attachment_ttl_hours = 1
            worker.config.require_worker_enabled = lambda: None
            worker.config.require_telegram = lambda: None
            worker.config.require_backend_auth = lambda: None
            worker._claim_session_lease = AsyncMock()
            worker.erp.audit_capabilities = AsyncMock(return_value={})

            class UnauthorizedClient:
                async def connect(self) -> None:
                    return None

                async def is_user_authorized(self) -> bool:
                    return False

                async def disconnect(self) -> None:
                    return None

            with (
                patch("cnc_telegram_worker.worker.TelegramClient", return_value=UnauthorizedClient()),
                patch("cnc_telegram_worker.worker.backfill_sheet_previews"),
            ):
                with self.assertRaisesRegex(RuntimeError, "Telethon session is not authorized"):
                    await worker.run_serve()

            worker._claim_session_lease.assert_not_awaited()

    async def test_session_claim_waits_for_exact_busy_lease_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp))
            worker.config.telegram_chat = "-100"
            worker.config.telegram_allowed_chat_ids = ("-100",)
            worker.config.worker_image_revision = "test-image"
            worker.config.worker_instance_id = "test-worker"
            worker.config.session_lease_ttl_seconds = 3
            worker.config.poll_interval_seconds = 1
            worker.config.require_session_lease_timing = lambda: None

            busy_response = httpx.Response(
                409,
                request=httpx.Request("POST", "http://backend/cnc-telegram/worker-session/claim"),
                json={
                    "error": {
                        "code": "CNC_TELEGRAM_SESSION_LEASE_BUSY",
                        "details": {
                            "workerInstanceId": "old-worker",
                            "workerImageRevision": "old-image",
                            "expiresAt": "2026-08-27T18:00:00Z",
                        },
                    },
                },
            )
            worker.erp.claim_worker_session = AsyncMock(side_effect=[
                ErpResponseError(busy_response, "worker session claim"),
                WorkerSessionLease("lease-token", 4),
            ])

            with (
                patch("cnc_telegram_worker.worker.asyncio.sleep", new=AsyncMock()) as sleep,
                patch("builtins.print") as output,
            ):
                await worker._claim_session_lease()

            self.assertEqual(worker.erp.claim_worker_session.await_count, 2)
            self.assertEqual([call.args[0] for call in sleep.await_args_list], [1])
            self.assertIn("ownerInstance=old-worker", output.call_args.args[0])
            self.assertIn("ownerRevision=old-image", output.call_args.args[0])

    async def test_session_claim_does_not_retry_other_409_errors(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp))
            worker.config.telegram_chat = "-100"
            worker.config.telegram_allowed_chat_ids = ("-100",)
            worker.config.worker_image_revision = "test-image"
            worker.config.worker_instance_id = "test-worker"
            worker.config.session_lease_ttl_seconds = 3
            worker.config.poll_interval_seconds = 1
            worker.config.require_session_lease_timing = lambda: None

            stale_response = httpx.Response(
                409,
                request=httpx.Request("POST", "http://backend/cnc-telegram/worker-session/claim"),
                json={"code": "CNC_TELEGRAM_SESSION_LEASE_STALE"},
            )
            worker.erp.claim_worker_session = AsyncMock(
                side_effect=ErpResponseError(stale_response, "worker session claim"),
            )

            with patch("cnc_telegram_worker.worker.asyncio.sleep", new=AsyncMock()) as sleep:
                with self.assertRaises(ErpResponseError):
                    await worker._claim_session_lease()

            worker.erp.claim_worker_session.assert_awaited_once()
            sleep.assert_not_awaited()

    async def test_session_claim_busy_retries_are_bounded_by_lease_ttl(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp))
            worker.config.telegram_chat = "-100"
            worker.config.telegram_allowed_chat_ids = ("-100",)
            worker.config.worker_image_revision = "test-image"
            worker.config.worker_instance_id = "test-worker"
            worker.config.session_lease_ttl_seconds = 3
            worker.config.poll_interval_seconds = 1
            worker.config.require_session_lease_timing = lambda: None

            def busy_error() -> ErpResponseError:
                response = httpx.Response(
                    409,
                    request=httpx.Request("POST", "http://backend/cnc-telegram/worker-session/claim"),
                    json={"code": "CNC_TELEGRAM_SESSION_LEASE_BUSY"},
                )
                return ErpResponseError(response, "worker session claim")

            worker.erp.claim_worker_session = AsyncMock(side_effect=[busy_error() for _ in range(5)])

            with patch("cnc_telegram_worker.worker.asyncio.sleep", new=AsyncMock()) as sleep:
                with self.assertRaises(ErpResponseError):
                    await worker._claim_session_lease()

            self.assertEqual(worker.erp.claim_worker_session.await_count, 5)
            self.assertEqual([call.args[0] for call in sleep.await_args_list], [1, 1, 1, 1])

    async def test_serve_never_scans_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            events: list[str] = []
            worker = make_worker(Path(temp))
            worker.config.enabled = True
            worker.config.stack_env = "test"
            worker.config.worker_role = "reader"
            worker.config.telegram_session_path = Path(temp) / "session"
            worker.config.telegram_api_id = 1
            worker.config.telegram_api_hash = "hash"
            worker.config.telegram_chat = "-100"
            worker.config.telegram_allowed_chat_ids = ("-100",)
            worker.config.erp_bearer_token = "token"
            worker.config.erp_worker_login = ""
            worker.config.erp_worker_password = ""
            worker.config.audit_spool_path = Path(temp) / "audit.sqlite3"
            worker.config.audit_allow_unsafe_path = True
            worker.config.session_lease_ttl_seconds = 90
            worker.config.session_lease_heartbeat_seconds = 30
            worker.config.poll_interval_seconds = 1
            worker.config.media_restore_poll_interval_seconds = 1
            worker.config.manual_svg_send_poll_interval_seconds = 1
            worker.config.temp_ttl_hours = 1
            worker.config.attachment_ttl_hours = 1
            worker.config.worker_image_revision = "test-image"
            worker.config.worker_instance_id = "test-worker"
            worker.config.can_send_manual_svg_uploads = True
            worker.config.require_worker_enabled = lambda: None
            worker.config.require_telegram = lambda: None
            worker.config.require_backend_auth = lambda: None
            worker.config.require_session_lease_timing = lambda: None
            worker.erp.set_session_lease = lambda _lease: None
            worker.erp.audit_capabilities = AsyncMock(return_value={})

            async def claim_session(**_kwargs: object) -> WorkerSessionLease:
                events.append("lease-success")
                return WorkerSessionLease("lease-token", 4)

            worker.erp.claim_worker_session = AsyncMock(side_effect=claim_session)

            class ServeClient:
                def __init__(self, *_args: object) -> None:
                    events.append("telegram-init")

                async def connect(self) -> None:
                    events.append("telegram-connect")
                    return None

                async def is_user_authorized(self) -> bool:
                    events.append("telegram-authorized")
                    return True

                async def get_entity(self, _chat: object) -> object:
                    return object()

                async def get_me(self) -> object:
                    return types.SimpleNamespace(id=42)

                async def disconnect(self) -> None:
                    return None

            async def stop_after_manual_poll(
                _client: object,
                _entity: object,
                _chat_id: str,
                stop_event: asyncio.Event,
                **_kwargs: object,
            ) -> None:
                events.append("queue")
                stop_event.set()

            worker._heartbeat_session = AsyncMock()
            worker.process_media_restore_requests = AsyncMock()
            worker.process_manual_svg_telegram_send_requests = AsyncMock()
            worker.poll_manual_svg_telegram_send_requests = stop_after_manual_poll
            worker.poll_media_restore_requests = AsyncMock()
            worker.scan_workday = AsyncMock()

            reconcile = AsyncMock()
            with (
                patch("cnc_telegram_worker.worker.TelegramClient", side_effect=ServeClient),
                patch("cnc_telegram_worker.worker.assert_allowed_chat"),
                patch("cnc_telegram_worker.worker.peer_id", return_value="-100"),
                patch("cnc_telegram_worker.worker.backfill_sheet_previews"),
                patch("cnc_telegram_worker.worker.flush_audit_spool", new=AsyncMock()),
                patch("cnc_telegram_worker.worker.reconcile_pending_processing_attempts", new=reconcile),
            ):
                await worker.run_serve()

            worker.scan_workday.assert_not_awaited()
            reconcile.assert_not_awaited()
            self.assertLess(events.index("telegram-authorized"), events.index("lease-success"))
            self.assertLess(events.index("lease-success"), events.index("queue"))
            self.assertLess(events.index("telegram-connect"), events.index("queue"))

    async def test_heartbeat_failure_stops_serve_fail_closed(self) -> None:
        worker = object.__new__(CncTelegramWorker)
        worker.config = types.SimpleNamespace(session_lease_heartbeat_seconds=0.001)
        worker.erp = types.SimpleNamespace(
            heartbeat_worker_session=AsyncMock(side_effect=RuntimeError("backend unavailable")),
        )
        stop_event = asyncio.Event()
        fatal_event = asyncio.Event()

        await asyncio.wait_for(
            worker._heartbeat_session(stop_event, fatal_event),
            timeout=1,
        )

        self.assertTrue(stop_event.is_set())
        self.assertTrue(fatal_event.is_set())

    async def test_daemon_is_fail_closed(self) -> None:
        worker = object.__new__(CncTelegramWorker)
        with self.assertRaisesRegex(RuntimeError, "daemon is deprecated"):
            await worker.run_daemon()


class WorkerCuttingSequenceIndexTest(unittest.IsolatedAsyncioTestCase):
    async def test_collects_cutting_sequence_reply_numbers_with_one_search(self) -> None:
        image_a = FakeMessage(100, text="2700", mime_type="image/jpeg")
        image_b = FakeMessage(200, text="2718", mime_type="image/jpeg")
        client = FakeTelegramClient([
            FakeMessage(901, text="Раскрой №8", reply_to=201),
            FakeMessage(902, text="не номер", reply_to=101),
            FakeMessage(903, text="Раскрой №7", reply_to=101),
            FakeMessage(904, text="Раскрой №99", reply_to=999),
        ])
        for message in client.messages:
            message.out = True

        vector_a = FakeMessage(101, filename="2700.svg", mime_type="image/svg+xml")
        vector_b = FakeMessage(201, filename="2718.svg", mime_type="image/svg+xml")
        index = await collect_cutting_sequence_reply_search_index(client, object(), {101, 201})
        groups = apply_cutting_sequence_reply_index(
            group_svg_messages([image_a, vector_a, image_b, vector_b]),
            index,
        )

        self.assertEqual(index, {101: 7, 201: 8})
        self.assertEqual(groups[0].cutting_sequence_no, 7)
        self.assertEqual(groups[1].cutting_sequence_no, 8)
        self.assertEqual(len(client.iter_messages_calls), 1)
        self.assertEqual(client.iter_messages_calls[0], {"search": "Раскрой", "limit": 1000})

    async def test_does_not_audit_search_results_for_other_source_messages(self) -> None:
        decisions: list[tuple[int, str]] = []
        selected = FakeMessage(903, text="Раскрой №7", reply_to=100)
        selected.out = True

        async def observe(message: FakeMessage, _ordinal: int, decision: str) -> None:
            decisions.append((int(message.id), decision))

        index = await collect_cutting_sequence_reply_search_index(
            FakeTelegramClient([
                FakeMessage(901, text="Раскрой №9"),
                FakeMessage(902, text="Раскрой №8", reply_to=999),
                selected,
            ]),
            object(),
            {100},
            observer=observe,
        )

        self.assertEqual(index, {100: 7})
        self.assertEqual(decisions, [(903, "reply_selected")])

    async def test_excludes_out_of_window_reply_and_records_exact_decisions(self) -> None:
        stale = FakeMessage(900, text="Раскрой №99", reply_to=100)
        stale.date = datetime(2026, 7, 23, 23, 59, tzinfo=timezone.utc)
        current = FakeMessage(901, text="Раскрой №7", reply_to=100)
        current.date = datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc)
        current.sender_id = 77
        current.out = True
        decisions: list[tuple[int, str]] = []

        async def observe(message: FakeMessage, ordinal: int, decision: str) -> None:
            decisions.append((int(message.id), decision))

        index = await collect_cutting_sequence_reply_search_index(
            FakeTelegramClient([stale, current]), object(), {100},
            session_user_id="77", workday=date(2026, 7, 24), business_timezone=timezone.utc,
            observer=observe,
        )

        self.assertEqual(index, {100: 7})
        self.assertEqual(decisions, [
            (900, "reply_outside_business_window"),
            (901, "reply_selected"),
        ])

    async def test_conflicting_numbers_are_ambiguous_and_supply_no_sequence(self) -> None:
        decisions: list[str] = []
        replies = [
            FakeMessage(910, text="Раскрой №7", reply_to=100),
            FakeMessage(911, text="Раскрой №8", reply_to=100),
        ]
        for reply in replies:
            reply.out = True

        async def observe(_message: FakeMessage, _ordinal: int, decision: str) -> None:
            decisions.append(decision)

        index = await collect_cutting_sequence_reply_search_index(
            FakeTelegramClient(replies),
            object(),
            {100},
            observer=observe,
        )

        self.assertEqual(index, {100: None})
        self.assertEqual(decisions, ["reply_selected", "reply_ambiguous"])

    async def test_local_state_mismatch_is_ambiguous_and_clears_sequence(self) -> None:
        image = FakeMessage(100, text="2700", mime_type="image/jpeg")
        vector = FakeMessage(101, filename="2700.svg", mime_type="image/svg+xml")
        groups = group_svg_messages([image, vector])
        groups = [replace(group, cutting_sequence_no=7) for group in groups]
        reply = FakeMessage(901, text="Раскрой №8", reply_to=100)
        reply.sender_id = 77
        reply.out = True
        decisions: list[str] = []

        async def observe(_message: FakeMessage, _ordinal: int, decision: str) -> None:
            decisions.append(decision)

        index = await collect_cutting_sequence_reply_search_index(
            FakeTelegramClient([reply]), object(), {100}, session_user_id="77",
            known_sequence_index={100: 7}, observer=observe,
        )
        updated = apply_cutting_sequence_reply_index(groups, index)

        self.assertEqual(index, {100: None})
        self.assertEqual(decisions, ["reply_ambiguous"])
        self.assertIsNone(updated[0].cutting_sequence_no)

    def test_missing_authenticated_reply_clears_local_sequence(self) -> None:
        image = FakeMessage(100, text="2700", mime_type="image/jpeg")
        vector = FakeMessage(101, filename="2700.svg", mime_type="image/svg+xml")
        groups = [
            replace(group, cutting_sequence_no=7)
            for group in group_svg_messages([image, vector])
        ]

        updated = apply_cutting_sequence_reply_index(groups, {})

        self.assertIsNone(updated[0].cutting_sequence_no)

    async def test_scan_rejects_local_sequence_when_reply_search_misses_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            worker.config.business_timezone = timezone.utc
            worker.config.max_messages_per_scan = 100
            worker.state.assign_cutting_sequence_number("telegram:-100123:100", existing_number=7)
            worker.state.mark_cutting_sequence_replied("telegram:-100123:100")
            worker.state.mark_posted(
                "telegram:-100123:100",
                "hash-a",
                1,
                "source-a",
                svg_cut_import_status="imported",
            )
            vector = FakeMessage(100, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            client = SearchMissTelegramClient([vector])
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)

            await worker.scan_workday(
                client, object(), "-100123", date(2026, 7, 24), spool, "77",
            )

            self.assertEqual(len(worker.erp.packets), 1)
            self.assertIsNone(worker.erp.packets[0]["cuttingSequenceNo"])
            self.assertEqual(worker.erp.packets[0]["svgImportMode"], {
                "validationMode": "lenient",
                "refreshImported": False,
            })
            operation_records = [
                operation
                for payload in worker.erp.audit_batches
                for operation in payload.get("operations", [])
                if operation["operationType"] == "message_processing"
            ]
            rejection_steps = [
                step
                for operation in operation_records
                for step in operation["steps"]
                if step["code"] == "reply_search" and step["status"] == "skipped"
            ]
            self.assertTrue(rejection_steps)
            self.assertIn("подтверждающий исходящий ответ Telegram не найден", rejection_steps[-1]["message"])
            spool.close()

    async def test_scan_audits_reply_taxonomy_even_when_local_state_has_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            worker.config.business_timezone = timezone.utc
            worker.config.max_messages_per_scan = 100
            worker.state.assign_cutting_sequence_number("telegram:-100123:100", existing_number=7)
            worker.state.mark_cutting_sequence_replied("telegram:-100123:100")
            worker.state.mark_posted(
                "telegram:-100123:100",
                "hash-a",
                1,
                "source-a",
                svg_cut_import_status="imported",
            )
            vector = FakeMessage(100, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            reply = FakeMessage(101, text="Раскрой №7", reply_to=100)
            reply.sender_id = 77
            reply.out = True
            client = FakeTelegramClient([reply, vector])

            async def skip_processing(*_args: object, **_kwargs: object) -> None:
                return None

            worker.process_group = skip_processing
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            await worker.scan_workday(
                client, object(), "-100123", date(2026, 7, 24), spool, "77",
            )

            self.assertTrue(any(call.get("search") == "Раскрой" for call in client.iter_messages_calls))
            reply_records = [
                message
                for payload in worker.erp.audit_batches
                for message in payload.get("messages", [])
                if message["sourceMessageId"] == "101"
            ]
            self.assertTrue(any(message["reasonCode"] == "reply_selected" for message in reply_records))
            spool.close()

    async def test_scan_rejects_reply_that_conflicts_with_local_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            worker.config.business_timezone = timezone.utc
            worker.config.max_messages_per_scan = 100
            worker.state.assign_cutting_sequence_number("telegram:-100123:100", existing_number=7)
            worker.state.mark_cutting_sequence_replied("telegram:-100123:100")
            worker.state.mark_posted(
                "telegram:-100123:100",
                "hash-a",
                1,
                "source-a",
                svg_cut_import_status="imported",
            )
            vector = FakeMessage(100, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            reply = FakeMessage(101, text="Раскрой №8", reply_to=100)
            reply.sender_id = 77
            reply.out = True
            client = FakeTelegramClient([reply, vector])
            processed: list[SvgGroup] = []

            async def capture_processing(
                _client: object, _entity: object, group: SvgGroup,
                _chat_id: str, _workday: date, **_kwargs: object,
            ) -> None:
                processed.append(group)

            worker.process_group = capture_processing
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            await worker.scan_workday(
                client, object(), "-100123", date(2026, 7, 24), spool, "77",
            )

            self.assertEqual(len(processed), 1)
            self.assertIsNone(processed[0].cutting_sequence_no)
            reply_records = [
                message
                for payload in worker.erp.audit_batches
                for message in payload.get("messages", [])
                if message["sourceMessageId"] == "101"
            ]
            self.assertTrue(any(message["reasonCode"] == "reply_ambiguous" for message in reply_records))
            spool.close()

    async def test_day_history_reply_missed_by_search_is_not_reported_as_selected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            worker.config.business_timezone = timezone.utc
            worker.config.max_messages_per_scan = 100
            vector = FakeMessage(100, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            reply = FakeMessage(101, text="Раскрой №8", reply_to=100)
            reply.sender_id = 77
            reply.out = True
            client = SearchMissTelegramClient([reply, vector])
            processed: list[SvgGroup] = []

            async def capture_processing(
                _client: object, _entity: object, group: SvgGroup,
                _chat_id: str, _workday: date, **_kwargs: object,
            ) -> None:
                processed.append(group)

            worker.process_group = capture_processing
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            await worker.scan_workday(
                client, object(), "-100123", date(2026, 7, 24), spool, "77",
            )

            self.assertIsNone(processed[0].cutting_sequence_no)
            records = [
                message
                for payload in worker.erp.audit_batches
                for message in payload.get("messages", [])
                if message["sourceMessageId"] == "101"
            ]
            record = records[-1]
            self.assertEqual(record["status"], "skipped")
            self.assertEqual(record["reasonCode"], "reply_unrelated")
            self.assertIn("не был выбран поиском", record["reasonMessage"])
            spool.close()


class WorkerAllowedChatTest(unittest.TestCase):
    def test_requires_exact_peer_id_without_suffix_aliases(self) -> None:
        assert_allowed_chat("-100123", ("-100123",))
        with self.assertRaisesRegex(RuntimeError, "not in TELEGRAM_ALLOWED_CHAT_ID"):
            assert_allowed_chat("-123", ("-100123",))

    def test_fails_closed_without_an_allowlist(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "must contain the exact resolved chat id"):
            assert_allowed_chat("-100123", ())


class WorkerCuttingSequenceStateTest(unittest.TestCase):
    def test_applies_known_replied_cutting_sequence_only_after_imported_backend_state(self) -> None:
        image_a = FakeMessage(100, text="2700", mime_type="image/jpeg")
        image_b = FakeMessage(200, text="2718", mime_type="image/jpeg")
        vector_a = FakeMessage(101, filename="2700.svg", mime_type="image/svg+xml")
        vector_b = FakeMessage(201, filename="2718.svg", mime_type="image/svg+xml")
        groups = group_svg_messages([image_a, vector_a, image_b, vector_b])
        chat_id = "-100123"

        with tempfile.TemporaryDirectory() as temp:
            state = StateStore(Path(temp) / "state.json")
            key_a = external_packet_key(chat_id, 101)
            key_b = external_packet_key(chat_id, 201)
            state.assign_cutting_sequence_number(key_a, existing_number=7)
            state.mark_cutting_sequence_replied(key_a)
            state.mark_posted(
                key_a,
                "hash-a",
                1,
                "source-a",
                svg_cut_import_status="imported",
            )
            state.assign_cutting_sequence_number(key_b, existing_number=8)

            updated = apply_known_cutting_sequence_state(groups, chat_id, state)

        self.assertEqual(updated[0].cutting_sequence_no, 7)
        self.assertIsNone(updated[1].cutting_sequence_no)

    def test_does_not_rehydrate_legacy_replied_sequence_without_backend_import_status(self) -> None:
        vector = FakeMessage(101, filename="2700.svg", mime_type="image/svg+xml")
        groups = group_svg_messages([vector])
        chat_id = "-100123"

        with tempfile.TemporaryDirectory() as temp:
            state = StateStore(Path(temp) / "state.json")
            key = external_packet_key(chat_id, 101)
            state.assign_cutting_sequence_number(key, existing_number=7)
            state.mark_cutting_sequence_replied(key)

            updated = apply_known_cutting_sequence_state(groups, chat_id, state)

        self.assertIsNone(updated[0].cutting_sequence_no)


class WorkerSvgProcessingTest(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_svg_does_not_post_packet(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp))
            group = SvgGroup(
                vector_message=FakeMessage(
                    300,
                    filename="invalid.svg",
                    mime_type="image/svg+xml",
                    media_content="<svg></svg>",
                ),
                image_message=None,
                comments=[],
                cutting_sequence_no=None,
                gcode_message=None,
            )

            await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24))

            self.assertEqual(worker.erp.packets, [])

    async def test_raised_svg_download_has_specific_terminal_reason(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            vector = FailingDownloadMessage(305, filename="layout.svg", mime_type="image/svg+xml")
            group = SvgGroup(vector, None, [], None, None)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with self.assertRaisesRegex(OSError, "media download failed"):
                await worker.process_group(
                    FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
                )

            operation = latest_operation(spool, "message_processing")
            self.assertEqual(operation["status"], "failed")
            self.assertEqual(operation["reasonCode"], "svg_download_failed")
            self.assertEqual(operation["errorCode"], "svg_download_failed")
            spool.close()

    async def test_raised_gcode_download_has_specific_terminal_reason(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            vector = FakeMessage(306, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            failing = FailingDownloadMessage(307, filename="program.txt", mime_type="text/plain")
            group = SvgGroup(vector, None, [], None, failing)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with self.assertRaisesRegex(OSError, "media download failed"):
                await worker.process_group(
                    FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
                )

            operation = latest_operation(spool, "message_processing")
            self.assertEqual(operation["reasonCode"], "gcode_download_failed")
            self.assertEqual(operation["errorCode"], "gcode_download_failed")
            self.assertEqual(audit.record_for(failing)["reasonCode"], "gcode_download_failed")
            spool.close()

    async def test_valid_standalone_svg_posts_one_packet_keyed_by_svg(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp))
            vector = FakeMessage(
                301,
                filename="CNC#1_1234.svg",
                mime_type="image/svg+xml",
                media_content=VALID_SVG,
            )
            group = SvgGroup(
                vector_message=vector,
                image_message=None,
                comments=[],
                cutting_sequence_no=None,
                gcode_message=None,
            )

            client = FakeTelegramClient([])
            await worker.process_group(client, object(), group, "-100123", date(2026, 7, 24))
            await worker.process_group(client, object(), group, "-100123", date(2026, 7, 24))

            self.assertEqual(len(worker.erp.packets), 1)
            packet = worker.erp.packets[0]
            self.assertEqual(packet["externalPacketKey"], "telegram:-100123:301")
            self.assertEqual(packet["cutLayout"]["status"], "valid")
            self.assertEqual(packet["sourceFiles"][0]["kind"], "svg")
            self.assertEqual(packet["sourceFiles"][0]["fileName"], "CNC#1_1234.svg")
            self.assertEqual(packet["sourceFiles"][0]["sha256"], "9210668b8e3da1b6aafe2a34068835c5c5cfa65742a712de94e728b6b4cce659")
            self.assertEqual(client.sent_messages, [])
            self.assertFalse(worker.state.cutting_sequence_replied("telegram:-100123:301"))

    async def test_valid_svg_audit_has_one_immutable_planned_operation_before_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            vector = FakeMessage(
                302,
                filename="CNC#1_1234.svg",
                mime_type="image/svg+xml",
                media_content=VALID_SVG,
            )
            group = SvgGroup(
                vector_message=vector,
                image_message=None,
                comments=[],
                cutting_sequence_no=None,
                gcode_message=None,
            )
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            await worker.process_group(
                FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
            )

            payloads = [json.loads(row[0]) for row in spool.connection.execute(
                "SELECT payload_json FROM audit_outbox ORDER BY rowid"
            ).fetchall()]
            operations = [
                operation
                for payload in payloads
                for operation in payload.get("operations", [])
                if operation["operationType"] == "message_processing"
            ]
            self.assertEqual([operation["status"] for operation in operations], ["planned", "succeeded"])
            self.assertEqual(operations[0]["externalPacketKey"], "telegram:-100123:302")
            self.assertIsNone(operations[0]["sourceVersion"])
            self.assertEqual(operations[1]["sourceVersion"], "1")
            spool.close()

    async def test_source_unchanged_marks_associated_image_and_gcode_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            vector = FakeMessage(351, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            image = FakeMessage(350, filename="sheet.jpg", mime_type="image/jpeg", media_content="image")
            gcode = FakeMessage(352, filename="program.txt", mime_type="text/plain", media_content="G0 X0 Y0")
            group = SvgGroup(
                vector_message=vector, image_message=image, comments=[],
                cutting_sequence_no=None, gcode_message=gcode,
            )
            await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24))
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            await worker.process_group(
                FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
            )

            self.assertEqual(audit.record_for(image)["reasonCode"], "image_ignored")
            self.assertEqual(audit.record_for(image)["status"], "skipped")
            self.assertEqual(audit.record_for(gcode)["reasonCode"], "gcode_ignored")
            self.assertEqual(audit.record_for(gcode)["status"], "skipped")
            spool.close()

    async def test_old_state_without_import_status_revalidates_backend_ingest(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            vector = FakeMessage(353, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            group = SvgGroup(vector_message=vector, image_message=None, comments=[], cutting_sequence_no=None, gcode_message=None)

            await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24))
            key = "telegram:-100123:353"
            worker.state._state["packets"][key].pop("svgCutImportStatus", None)
            worker.state._write()

            await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24))

            self.assertEqual(len(worker.erp.packets), 2)
            self.assertEqual(worker.erp.packets[0]["externalPacketKey"], key)
            self.assertEqual(worker.erp.packets[1]["externalPacketKey"], key)
            self.assertEqual(worker.state._state["packets"][key]["svgCutImportStatus"], "imported")

    async def test_temp_directory_failure_terminalizes_operation_and_attachments(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            worker.config.temp_dir.write_text("not a directory", encoding="utf-8")
            vector = FakeMessage(360, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            image = FakeMessage(361, filename="sheet.jpg", mime_type="image/jpeg", media_content="image")
            gcode = FakeMessage(362, filename="program.txt", mime_type="text/plain", media_content="G0 X0 Y0")
            group = SvgGroup(vector, image, [], None, gcode)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with self.assertRaises((FileExistsError, NotADirectoryError)):
                await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit)

            operation = latest_operation(spool, "message_processing")
            self.assertEqual(operation["status"], "failed")
            self.assertEqual(operation["reasonCode"], "unexpected_worker_error")
            self.assertEqual(audit.record_for(image)["status"], "skipped")
            self.assertEqual(audit.record_for(gcode)["status"], "skipped")
            spool.close()

    async def test_gcode_parse_failure_terminalizes_attachment_and_operation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            vector = FakeMessage(370, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            gcode = FakeMessage(371, filename="program.txt", mime_type="text/plain", media_content="broken")
            group = SvgGroup(vector, None, [], None, gcode)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with patch("cnc_telegram_worker.worker.parse_gcode_text", side_effect=ValueError("bad G-code")):
                with self.assertRaisesRegex(ValueError, "bad G-code"):
                    await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit)

            operation = latest_operation(spool, "message_processing")
            self.assertEqual(operation["status"], "failed")
            self.assertEqual(operation["reasonCode"], "gcode_parse_failed")
            self.assertEqual(audit.record_for(gcode)["status"], "failed")
            self.assertEqual(audit.record_for(gcode)["reasonCode"], "gcode_parse_failed")
            spool.close()

    async def test_gcode_parse_failure_does_not_leave_image_marked_used(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            vector = FakeMessage(372, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            image = FakeMessage(371, filename="sheet.jpg", mime_type="image/jpeg", media_content="image")
            gcode = FakeMessage(373, filename="program.txt", mime_type="text/plain", media_content="broken")
            group = SvgGroup(vector, image, [], None, gcode)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with patch("cnc_telegram_worker.worker.parse_gcode_text", side_effect=ValueError("bad G-code")):
                with self.assertRaisesRegex(ValueError, "bad G-code"):
                    await worker.process_group(
                        FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
                    )

            self.assertEqual(audit.record_for(image)["status"], "skipped")
            self.assertEqual(audit.record_for(image)["reasonCode"], "image_ignored")
            self.assertEqual(audit.record_for(gcode)["status"], "failed")
            image_updates = [
                message
                for row in spool.connection.execute("SELECT payload_json FROM audit_outbox ORDER BY rowid").fetchall()
                for message in json.loads(row[0]).get("messages", [])
                if message["sourceMessageId"] == "371"
            ]
            self.assertFalse(any(message["status"] == "used" for message in image_updates))
            spool.close()

    async def test_packet_build_failure_keeps_parsed_attachments_truthful(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            vector = FakeMessage(375, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            image = FakeMessage(374, filename="sheet.jpg", mime_type="image/jpeg", media_content="image")
            gcode = FakeMessage(376, filename="program.txt", mime_type="text/plain", media_content="G0 X0 Y0")
            group = SvgGroup(vector, image, [], None, gcode)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with patch("cnc_telegram_worker.worker.build_structured_packet", side_effect=ValueError("packet failed")):
                with self.assertRaisesRegex(ValueError, "packet failed"):
                    await worker.process_group(
                        FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
                    )

            self.assertEqual(latest_operation(spool, "message_processing")["reasonCode"], "unexpected_worker_error")
            self.assertEqual(audit.record_for(image)["status"], "skipped")
            self.assertEqual(audit.record_for(gcode)["status"], "skipped")
            attachment_updates = [
                message
                for row in spool.connection.execute("SELECT payload_json FROM audit_outbox ORDER BY rowid").fetchall()
                for message in json.loads(row[0]).get("messages", [])
                if message["sourceMessageId"] in {"374", "376"}
            ]
            self.assertFalse(any(message["status"] == "used" for message in attachment_updates))
            spool.close()

    async def test_success_marks_gcode_used_and_image_ignored_after_packet_build(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            vector = FakeMessage(378, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            image = FakeMessage(377, filename="sheet.jpg", mime_type="image/jpeg", media_content="image")
            gcode = FakeMessage(379, filename="program.txt", mime_type="text/plain", media_content="G0 X0 Y0")
            group = SvgGroup(vector, image, [], None, gcode)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            await worker.process_group(
                FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
            )

            self.assertEqual(audit.record_for(image)["status"], "skipped")
            self.assertEqual(audit.record_for(image)["reasonCode"], "image_ignored")
            self.assertEqual(audit.record_for(gcode)["status"], "used")
            self.assertEqual(audit.record_for(gcode)["reasonCode"], "gcode_selected")
            self.assertEqual(latest_operation(spool, "message_processing")["reasonCode"], "backend_ingest_succeeded")
            spool.close()

    async def test_payload_unchanged_does_not_advance_state_before_terminal_audit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            vector = FakeMessage(380, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            group = SvgGroup(vector, None, [], None, None)
            await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24))
            key = "telegram:-100123:380"
            saved = worker.state._state["packets"][key]
            worker.state.mark_posted(
                key,
                saved["payloadHash"],
                saved["sourceVersion"],
                "old-fingerprint",
                svg_cut_import_status="imported",
            )
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)
            spool.connection.execute("""
              CREATE TEMP TRIGGER fail_payload_unchanged_audit
              BEFORE INSERT ON audit_outbox
              WHEN NEW.payload_json LIKE '%payload_unchanged%'
              BEGIN SELECT RAISE(ABORT, 'forced terminal audit failure'); END
            """)

            with self.assertRaisesRegex(RuntimeError, "forced terminal audit failure"):
                await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit)

            self.assertEqual(worker.state._state["packets"][key]["sourceFingerprint"], "old-fingerprint")
            saved_operation = json.loads(spool.connection.execute(
                "SELECT payload_json FROM audit_outbox WHERE payload_json LIKE '%message_processing%' ORDER BY rowid DESC LIMIT 1"
            ).fetchone()[0])["operations"][0]
            self.assertEqual(saved_operation["status"], "planned")
            spool.close()

    async def test_each_valid_svg_posts_separate_packet(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp))
            vectors = [
                FakeMessage(
                    message_id,
                    filename=f"CNC#1_1234-{message_id}.svg",
                    mime_type="image/svg+xml",
                    media_content=VALID_SVG,
                )
                for message_id in (310, 311)
            ]

            for group in group_svg_messages(vectors):
                await worker.process_group(
                    FakeTelegramClient([]),
                    object(),
                    group,
                    "-100123",
                    date(2026, 7, 24),
                )

            self.assertEqual(
                [packet["externalPacketKey"] for packet in worker.erp.packets],
                ["telegram:-100123:310", "telegram:-100123:311"],
            )

    async def test_writer_posts_cutting_sequence_reply(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp), can_write_chat=True)
            vector = FakeMessage(
                320,
                filename="CNC#1_1234.svg",
                mime_type="image/svg+xml",
                media_content=VALID_SVG,
            )
            group = SvgGroup(
                vector_message=vector,
                image_message=None,
                comments=[],
                cutting_sequence_no=None,
                gcode_message=None,
            )
            client = FakeTelegramClient([])
            entity = object()

            await worker.process_group(client, entity, group, "-100123", date(2026, 7, 24))

            self.assertEqual(
                client.sent_messages,
                [{"entity": entity, "text": "Раскрой №12", "reply_to": 320}],
            )
            self.assertTrue(worker.state.cutting_sequence_replied("telegram:-100123:320"))

    async def test_existing_telegram_reply_persists_only_after_backend_imported(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp), can_write_chat=True)
            vector = FakeMessage(
                323,
                filename="CNC#1_1234.svg",
                mime_type="image/svg+xml",
                media_content=VALID_SVG,
            )
            group = SvgGroup(
                vector_message=vector,
                image_message=None,
                comments=[],
                cutting_sequence_no=12,
                gcode_message=None,
            )
            client = FakeTelegramClient([])

            await worker.process_group(client, object(), group, "-100123", date(2026, 7, 24))

            self.assertEqual(client.sent_messages, [])
            self.assertEqual(worker.state.cutting_sequence_number("telegram:-100123:323"), 12)
            self.assertTrue(worker.state.cutting_sequence_replied("telegram:-100123:323"))

    async def test_writer_does_not_reply_when_backend_skips_existing_svg(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp), can_write_chat=True)
            worker.erp = SkippedDuplicateErpClient()
            vector = FakeMessage(
                321,
                filename="CNC#1_1234.svg",
                mime_type="image/svg+xml",
                media_content=VALID_SVG,
            )
            group = SvgGroup(
                vector_message=vector,
                image_message=None,
                comments=[],
                cutting_sequence_no=None,
                gcode_message=None,
            )
            client = FakeTelegramClient([])

            await worker.process_group(client, object(), group, "-100123", date(2026, 7, 24))

            self.assertEqual(client.sent_messages, [])
            self.assertIsNone(worker.state.cutting_sequence_number("telegram:-100123:321"))
            self.assertFalse(worker.state.cutting_sequence_replied("telegram:-100123:321"))
            self.assertEqual(
                worker.state._state["packets"]["telegram:-100123:321"]["svgCutImportStatus"],
                "skipped",
            )
            self.assertEqual(worker.state._state["packets"]["telegram:-100123:321"]["cutJobId"], 98)

    async def test_duplicate_source_clears_wrong_existing_telegram_reply_number(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp), can_write_chat=True)
            worker.erp = SkippedDuplicateErpClient()
            vector = FakeMessage(
                322,
                filename="CNC#1_1234.svg",
                mime_type="image/svg+xml",
                media_content=VALID_SVG,
            )
            group = SvgGroup(
                vector_message=vector,
                image_message=None,
                comments=[],
                cutting_sequence_no=13,
                gcode_message=None,
            )
            client = FakeTelegramClient([])

            await worker.process_group(client, object(), group, "-100123", date(2026, 7, 24))

            self.assertEqual(client.sent_messages, [])
            self.assertIsNone(worker.state.cutting_sequence_number("telegram:-100123:322"))
            self.assertFalse(worker.state.cutting_sequence_replied("telegram:-100123:322"))
            self.assertEqual(
                worker.state._state["packets"]["telegram:-100123:322"]["svgCutImportStatus"],
                "skipped",
            )

    async def test_duplicate_source_retry_uses_new_source_version_and_idempotency_key(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp), can_write_chat=True)
            worker.erp = SkippedDuplicateErpClient()
            vector = FakeMessage(
                324,
                filename="CNC#1_1234.svg",
                mime_type="image/svg+xml",
                media_content=VALID_SVG,
            )
            group = SvgGroup(
                vector_message=vector,
                image_message=None,
                comments=[],
                cutting_sequence_no=None,
                gcode_message=None,
            )

            await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24))
            await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24))

            self.assertEqual([packet["source"]["version"] for packet in worker.erp.packets], [1, 2])
            self.assertEqual(worker.state._state["packets"]["telegram:-100123:324"]["lastSkippedSourceVersion"], 2)
            self.assertNotIn("sourceVersion", worker.state._state["packets"]["telegram:-100123:324"])
            self.assertNotIn("payloadHash", worker.state._state["packets"]["telegram:-100123:324"])

    async def test_valid_svg_ignores_screenshot_ocr_even_when_glm_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            vector = FakeMessage(
                331,
                filename="CNC#1_1234.svg",
                mime_type="image/svg+xml",
                media_content=VALID_SVG,
            )
            image = FakeMessage(
                330,
                filename="sheet.jpg",
                mime_type="image/jpeg",
                media_content="fake-image",
            )
            group = SvgGroup(
                vector_message=vector,
                image_message=image,
                comments=[],
                cutting_sequence_no=None,
                gcode_message=None,
            )
            ocr_result = OcrResult(items=[{
                "orderName": "1234",
                "detailNumber": 7,
                "widthMm": 200,
                "heightMm": 100,
                "quantity": 1,
            }])

            with patch(
                "cnc_telegram_worker.worker.run_ocr_command",
                new_callable=AsyncMock,
                return_value=ocr_result,
            ) as run_ocr:
                normal = make_worker(temp_path / "normal", ocr_engine="rapidocr-ppocrv5-eslav")
                await normal.process_group(
                    FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24)
                )
                run_ocr.assert_not_awaited()

                fallback = make_worker(
                    temp_path / "fallback",
                    enable_glm_ocr=True,
                    ocr_engine="glm-ocr-0.9b-q8",
                    ocr_command="python -m cnc_telegram_worker.glm_ocr_client --image {image}",
                    ocr_command_timeout_seconds=720,
                )
                await fallback.process_group(
                    FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24)
                )

            run_ocr.assert_not_awaited()
            self.assertEqual(fallback.erp.packets[0]["ocrEngine"], "glm-ocr-0.9b-q8")
            self.assertEqual(fallback.erp.packets[0]["items"][0]["orderName"], "1234")
            self.assertIsNone(fallback.erp.packets[0]["sheetImage"])

    async def test_ambiguous_backend_failure_stays_planned_for_idempotent_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            worker.erp = FailingErpClient()
            vector = FakeMessage(330, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            group = SvgGroup(vector_message=vector, image_message=None, comments=[], cutting_sequence_no=None, gcode_message=None)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with self.assertRaisesRegex(RuntimeError, "ERP unavailable"):
                await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit)

            operation = latest_processing_attempt(spool)
            self.assertEqual(operation["status"], "planned")
            self.assertEqual(operation["errorCode"], "backend_ingest_failed")
            self.assertEqual(len(spool.pending_processing_attempts()), 1)
            spool.close()

    async def test_crash_after_erp_accept_is_recovered_with_same_durable_packet(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            accepting_erp = CrashAfterAcceptErpClient()
            worker.erp = accepting_erp
            vector = FakeMessage(335, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            group = SvgGroup(vector, None, [], None, None)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with self.assertRaisesRegex(KeyboardInterrupt, "process death"):
                await worker.process_group(
                    FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
                )

            pending = spool.pending_processing_attempts()
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0]["packet"], accepting_erp.packets[0])
            recovery_erp = FakeErpClient()
            recovered = await reconcile_pending_processing_attempts(spool, recovery_erp, worker.state)
            self.assertEqual(len(recovered), 1)
            self.assertEqual(recovery_erp.packets, accepting_erp.packets)
            self.assertEqual(latest_processing_attempt(spool)["status"], "succeeded")
            self.assertTrue(worker.state.source_unchanged(
                "telegram:-100123:335", pending[0]["sourceFingerprint"],
            ))
            spool.close()

    async def test_processing_recovery_skips_duplicate_source_without_assigning_reply_number(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            accepting_erp = CrashAfterAcceptErpClient()
            worker.erp = accepting_erp
            vector = FakeMessage(336, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            group = SvgGroup(vector, None, [], None, None)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with self.assertRaisesRegex(KeyboardInterrupt, "process death"):
                await worker.process_group(
                    FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
                )

            pending = spool.pending_processing_attempts()
            recovery_erp = SkippedDuplicateErpClient()
            recovered = await reconcile_pending_processing_attempts(spool, recovery_erp, worker.state)

            self.assertEqual(len(recovered), 1)
            self.assertEqual(recovery_erp.packets, accepting_erp.packets)
            operation = latest_processing_attempt(spool)
            self.assertEqual(operation["status"], "succeeded")
            self.assertEqual(operation["reasonCode"], "backend_duplicate_source_file")
            self.assertEqual(operation["cutJobId"], "98")
            self.assertIsNone(worker.state.cutting_sequence_number("telegram:-100123:336"))
            self.assertFalse(worker.state.source_unchanged(
                "telegram:-100123:336", pending[0]["sourceFingerprint"],
            ))
            self.assertEqual(
                worker.state._state["packets"]["telegram:-100123:336"]["svgCutImportStatus"],
                "skipped",
            )
            spool.close()

    async def test_processing_recovery_uses_state_when_packet_was_already_posted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            worker.erp = FailingErpClient()
            vector = FakeMessage(338, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            group = SvgGroup(vector, None, [], None, None)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with self.assertRaisesRegex(RuntimeError, "ERP unavailable"):
                await worker.process_group(
                    FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
                )

            pending = spool.pending_processing_attempts()
            self.assertEqual(len(pending), 1)
            packet = pending[0]["packet"]
            worker.state.assign_cutting_sequence_number(packet["externalPacketKey"], existing_number=61)
            worker.state.mark_posted(
                packet["externalPacketKey"],
                pending[0]["payloadHash"],
                packet["source"]["version"],
                "sha256:previous-source-fingerprint",
                svg_cut_import_status="imported",
            )

            recovery_erp = FakeErpClient()
            recovered = await reconcile_pending_processing_attempts(spool, recovery_erp, worker.state)

            self.assertEqual(len(recovered), 1)
            self.assertEqual(recovery_erp.packets, [])
            operation = latest_processing_attempt(spool)
            self.assertEqual(operation["status"], "succeeded")
            self.assertEqual(operation["cuttingSequenceNo"], 61)
            self.assertEqual(spool.pending_processing_attempts(), [])
            spool.close()

    async def test_processing_recovery_defers_transient_backend_failure_with_saved_record(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            accepting_erp = CrashAfterAcceptErpClient()
            worker.erp = accepting_erp
            vector = FakeMessage(337, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            group = SvgGroup(vector, None, [], None, None)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with self.assertRaises(KeyboardInterrupt):
                await worker.process_group(
                    FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
                )

            failing_erp = FailingErpClient()
            recovered = await reconcile_pending_processing_attempts(spool, failing_erp, worker.state)

            self.assertEqual(recovered, [])
            self.assertEqual(failing_erp.packets, accepting_erp.packets)
            operation = latest_processing_attempt(spool)
            self.assertEqual(operation["status"], "planned")
            self.assertEqual(operation["errorCode"], "backend_ingest_failed")
            self.assertEqual(len(spool.pending_processing_attempts()), 1)
            spool.close()

    async def test_recovery_terminalizes_definite_backend_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path)
            worker.erp = CrashAfterAcceptErpClient()
            vector = FakeMessage(336, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            group = SvgGroup(vector, None, [], None, None)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", False)

            with self.assertRaises(KeyboardInterrupt):
                await worker.process_group(
                    FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit,
                )

            rejecting_erp = RejectingErpClient()
            recovered = await reconcile_pending_processing_attempts(spool, rejecting_erp, worker.state)

            self.assertEqual(len(recovered), 1)
            operation = latest_processing_attempt(spool)
            self.assertEqual(operation["status"], "failed")
            self.assertEqual(operation["reasonCode"], "backend_ingest_failed")
            self.assertEqual(operation["errorCode"], "backend_ingest_failed")
            self.assertEqual(spool.pending_processing_attempts(), [])
            spool.close()

    async def test_reply_send_failure_has_specific_terminal_audit_reason(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            worker = make_worker(temp_path, can_write_chat=True)
            vector = FakeMessage(340, filename="layout.svg", mime_type="image/svg+xml", media_content=VALID_SVG)
            group = SvgGroup(vector_message=vector, image_message=None, comments=[], cutting_sequence_no=None, gcode_message=None)
            spool = AuditSpool(temp_path / "audit.sqlite3", allow_unsafe_path=True)
            audit = ScanAudit.start(spool, "-100123", date(2026, 7, 24), "77", "v1", True)

            with self.assertRaisesRegex(RuntimeError, "Telegram send failed"):
                await worker.process_group(FailingTelegramClient([]), object(), group, "-100123", date(2026, 7, 24), audit=audit)

            operation = latest_reply_attempt(spool)
            self.assertEqual(operation["status"], "planned")
            self.assertEqual(operation["errorCode"], "reply_send_failed")
            self.assertEqual(operation["responses"][-1]["status"], "incomplete")
            self.assertTrue(spool.has_unresolved_reply("-100123", "340"))

            sent = FakeMessage(341, text="Раскрой №12", reply_to=340)
            sent.date = datetime.fromisoformat(operation["plannedAt"])
            sent.sender_id = 77
            sent.out = True
            reconciled = await reconcile_pending_replies(
                spool, FakeTelegramClient([sent]), object(), "77",
            )
            self.assertEqual(len(reconciled), 1)
            self.assertEqual(latest_reply_attempt(spool)["status"], "reconciled")
            reconciliation_payloads = [
                json.loads(row[0])
                for row in spool.connection.execute("SELECT payload_json FROM audit_outbox ORDER BY rowid").fetchall()
                if json.loads(row[0]).get("observations")
            ]
            planned_replies = [
                operation
                for payload in [json.loads(row[0]) for row in spool.connection.execute(
                    "SELECT payload_json FROM audit_outbox ORDER BY rowid"
                ).fetchall()]
                for operation in payload.get("operations", [])
                if operation["operationType"] == "telegram_reply" and operation["status"] == "planned"
            ]
            self.assertEqual(reconciliation_payloads[-1]["operations"], [planned_replies[0]])
            spool.close()


def make_worker(
    temp_dir: Path,
    *,
    can_write_chat: bool = False,
    enable_glm_ocr: bool = False,
    ocr_engine: str = "none",
    ocr_command: str = "",
    ocr_command_timeout_seconds: int = 180,
) -> CncTelegramWorker:
    worker = object.__new__(CncTelegramWorker)
    worker.config = types.SimpleNamespace(
        can_write_chat=can_write_chat,
        resend_unchanged=False,
        parser_version="test-svg-v1",
        svg_validation_mode="lenient",
        enable_glm_ocr=enable_glm_ocr,
        ocr_engine=ocr_engine,
        ocr_command=ocr_command,
        ocr_command_timeout_seconds=ocr_command_timeout_seconds,
        temp_dir=temp_dir / "tmp",
        media_dir=temp_dir / "media",
        default_machine="",
        default_material="МДФ 16мм",
    )
    worker.state = StateStore(temp_dir / "state.json")
    worker.erp = FakeErpClient()
    return worker


def latest_operation(spool: AuditSpool, operation_type: str) -> dict[str, object]:
    payloads = [json.loads(row[0]) for row in spool.connection.execute(
        "SELECT payload_json FROM audit_outbox ORDER BY created_at,outbox_id"
    ).fetchall()]
    operations = [
        operation
        for payload in payloads
        for operation in payload.get("operations", [])
        if operation["operationType"] == operation_type
    ]
    return operations[-1]


def latest_processing_attempt(spool: AuditSpool) -> dict[str, object]:
    row = spool.connection.execute(
        "SELECT operation_json FROM processing_attempts ORDER BY updated_at,operation_key DESC LIMIT 1"
    ).fetchone()
    assert row is not None
    return json.loads(row[0])


def latest_reply_attempt(spool: AuditSpool) -> dict[str, object]:
    row = spool.connection.execute(
        "SELECT operation_json FROM reply_attempts ORDER BY updated_at,operation_key DESC LIMIT 1"
    ).fetchone()
    assert row is not None
    return json.loads(row[0])


if __name__ == "__main__":
    unittest.main()
