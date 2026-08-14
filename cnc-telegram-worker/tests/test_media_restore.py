from __future__ import annotations

import io
import asyncio
import base64
import hashlib
import mimetypes
import os
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from PIL import Image

telethon_stub = types.ModuleType("telethon")
telethon_stub.TelegramClient = object
telethon_stub.utils = types.SimpleNamespace(get_peer_id=lambda entity: entity)
sys.modules.setdefault("telethon", telethon_stub)

from cnc_telegram_worker.cleanup import cleanup_temp_dir
from cnc_telegram_worker.audit import AuditSpool
from cnc_telegram_worker.worker import (
    CncTelegramWorker,
    SHEET_PREVIEW_DIRECTORY,
    backfill_sheet_previews,
    persist_sheet_image,
    sheet_preview_key,
)


class ImageMessage:
    id = 10847
    file = SimpleNamespace(name="sheet.png", mime_type="image/png")
    photo = None

    def __init__(self, body: bytes) -> None:
        self.body = body

    async def download_media(self, *, file: str) -> str:
        Path(file).write_bytes(self.body)
        return file


class RestoreClient:
    def __init__(self, message: ImageMessage | None) -> None:
        self.message = message

    async def get_messages(self, _entity: object, *, ids: int):
        return self.message if self.message and ids == self.message.id else None


class ManualSvgSendClient:
    def __init__(self) -> None:
        self.sent_files: list[str] = []
        self.calls: list[dict[str, object]] = []
        self.messages: list[str] = []

    async def send_file(self, _entity: object, files: list[str] | str, *, caption: str | None = None, force_document: bool = False):
        file_list = files if isinstance(files, list) else [files]
        self.sent_files.extend(file_list)
        self.calls.append({
            "files": file_list,
            "isBatch": isinstance(files, list),
            "caption": caption,
            "forceDocument": force_document,
        })
        path = Path(file_list[0])
        return SimpleNamespace(
            id=8000 + len(self.calls),
            date=datetime(2026, 8, 14, 5, len(self.calls), tzinfo=timezone.utc),
            file=SimpleNamespace(name=path.name, mime_type=mimetypes.guess_type(path.name)[0]),
            photo=None if force_document else object(),
            out=True,
        )

    async def send_message(self, _entity: object, message: str):
        self.messages.append(message)
        return SimpleNamespace(
            id=9000 + len(self.messages),
            date=datetime(2026, 8, 14, 6, len(self.messages), tzinfo=timezone.utc),
            raw_text=message,
            out=True,
        )


class MediaRestoreTest(unittest.IsolatedAsyncioTestCase):
    def test_persists_small_preview_and_cleanup_keeps_it(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            media_dir = Path(root, "media")
            source = Path(root, "source.png")
            source.write_bytes(png_bytes())

            media = persist_sheet_image(media_dir, "-100", 10847, source)
            preview = media_dir / SHEET_PREVIEW_DIRECTORY / sheet_preview_key(media["storageKey"])

            self.assertTrue(preview.is_file())
            with Image.open(preview) as image:
                self.assertLessEqual(image.width, 360)
                self.assertLessEqual(image.height, 240)

            old = 1_700_000_000
            os.utime(media_dir / media["storageKey"], (old, old))
            os.utime(preview, (old, old))
            cleanup_temp_dir(
                media_dir,
                1,
                excluded_relative_dirs=frozenset({SHEET_PREVIEW_DIRECTORY}),
            )
            self.assertFalse((media_dir / media["storageKey"]).exists())
            self.assertTrue(preview.exists())

    def test_backfills_missing_previews_once(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            media_dir = Path(root)
            Path(media_dir, "tg_100_10.png").write_bytes(png_bytes())

            self.assertEqual(backfill_sheet_previews(media_dir), 1)
            self.assertEqual(backfill_sheet_previews(media_dir), 0)

    def test_required_preview_failure_does_not_overwrite_existing_original(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            media_dir = Path(root, "media")
            valid = Path(root, "valid.png")
            invalid = Path(root, "invalid.png")
            valid.write_bytes(png_bytes())
            invalid.write_bytes(b"not-an-image")
            first = persist_sheet_image(media_dir, "-100", 10847, valid)
            original = media_dir / first["storageKey"]
            expected = original.read_bytes()

            with self.assertRaises(ValueError):
                persist_sheet_image(
                    media_dir,
                    "-100",
                    10847,
                    invalid,
                    require_preview=True,
                )

            self.assertEqual(original.read_bytes(), expected)

    async def test_worker_claims_downloads_and_completes_restore(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            worker.erp = SimpleNamespace(
                claim_media_restores=AsyncMock(return_value={
                    "capability": "cnc_telegram_media_restore_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000002",
                        "sourceChatId": "-100",
                        "sourceMessageId": 10847,
                        "storageKey": "tg_100_10847.png",
                    }],
                }),
                complete_media_restore=AsyncMock(return_value={}),
                fail_media_restore=AsyncMock(return_value={}),
            )

            await worker.process_media_restore_requests(RestoreClient(ImageMessage(png_bytes())), object(), "-100")

            worker.erp.complete_media_restore.assert_awaited_once()
            worker.erp.fail_media_restore.assert_not_awaited()
            self.assertTrue(Path(root, "media", "tg_100_10847.png").is_file())
            self.assertTrue(Path(root, "media", "previews", "tg_100_10847.preview.jpg").is_file())

    async def test_worker_reports_deleted_telegram_message(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            worker.erp = SimpleNamespace(
                claim_media_restores=AsyncMock(return_value={
                    "capability": "cnc_telegram_media_restore_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000002",
                        "sourceChatId": "-100",
                        "sourceMessageId": 10847,
                        "storageKey": "tg_100_10847.png",
                    }],
                }),
                complete_media_restore=AsyncMock(return_value={}),
                fail_media_restore=AsyncMock(return_value={}),
            )

            await worker.process_media_restore_requests(RestoreClient(None), object(), "-100")

            worker.erp.complete_media_restore.assert_not_awaited()
            worker.erp.fail_media_restore.assert_awaited_once()
            self.assertIn("unavailable", worker.erp.fail_media_restore.await_args.args[1])

    async def test_worker_sends_manual_svg_files_and_completes_request(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            svg_payload = manual_svg_send_file("svg", "CNC#1_2777+2723-HDF.svg", b"<svg></svg>")
            svg_payload["base64Content"] = with_base64_line_breaks(str(svg_payload["base64Content"]))
            worker.erp = SimpleNamespace(
                claim_manual_svg_telegram_sends=AsyncMock(return_value={
                    "capability": "cnc_manual_svg_telegram_send_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000003",
                        "packetId": "00000000-0000-4000-8000-000000000011",
                        "messageText": "Фрезы для ХДФ: 8",
                        "files": [
                            svg_payload,
                            manual_svg_send_file("screenshot", "CNC#1_2777+2723-HDF.jpg", png_bytes()),
                            manual_svg_send_file("gcode", "CNC#1_2777+2723-HDF.nc", b"G01 X1"),
                        ],
                    }],
                }),
                complete_manual_svg_telegram_send=AsyncMock(return_value={}),
                fail_manual_svg_telegram_send=AsyncMock(return_value={}),
            )
            client = ManualSvgSendClient()

            await worker.process_manual_svg_telegram_send_requests(client, object(), "-100")

            worker.erp.complete_manual_svg_telegram_send.assert_awaited_once()
            worker.erp.fail_manual_svg_telegram_send.assert_not_awaited()
            args = worker.erp.complete_manual_svg_telegram_send.await_args.args
            self.assertEqual(args[0], "00000000-0000-4000-8000-000000000003")
            self.assertEqual(args[1]["sentChatId"], "-100")
            self.assertEqual(args[1]["sentMessageIds"], ["8001", "8002", "8003", "9001"])
            self.assertEqual(len(client.calls), 3)
            self.assertFalse(any(call["isBatch"] for call in client.calls))
            self.assertTrue(all(call["caption"] is None for call in client.calls))
            self.assertEqual([call["forceDocument"] for call in client.calls], [True, True, False])
            self.assertEqual([Path(path).name for path in client.sent_files], [
                "CNC#1_2777+2723-HDF.nc",
                "CNC#1_2777+2723-HDF.svg",
                "CNC#1_2777+2723-HDF.jpg",
            ])
            self.assertEqual(client.messages, ["Фрезы для ХДФ: 8"])

    async def test_worker_sends_screenshot_as_image_and_comment_last(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            worker.erp = SimpleNamespace(
                claim_manual_svg_telegram_sends=AsyncMock(return_value={
                    "capability": "cnc_manual_svg_telegram_send_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000005",
                        "messageText": "Черновой",
                        "files": [
                            manual_svg_send_file("svg", "CNC#2_2769-HDF.svg", b"<svg></svg>"),
                            manual_svg_send_file("screenshot", "CNC#2_2769-HDF.png", png_bytes()),
                        ],
                    }],
                }),
                complete_manual_svg_telegram_send=AsyncMock(return_value={}),
                fail_manual_svg_telegram_send=AsyncMock(return_value={}),
            )
            client = ManualSvgSendClient()

            await worker.process_manual_svg_telegram_send_requests(client, object(), "-100")

            worker.erp.complete_manual_svg_telegram_send.assert_awaited_once()
            worker.erp.fail_manual_svg_telegram_send.assert_not_awaited()
            args = worker.erp.complete_manual_svg_telegram_send.await_args.args
            self.assertEqual(args[1]["sentMessageIds"], ["8001", "8002", "9001"])
            self.assertEqual(len(client.calls), 2)
            self.assertFalse(any(call["isBatch"] for call in client.calls))
            self.assertTrue(all(call["caption"] is None for call in client.calls))
            self.assertEqual([call["forceDocument"] for call in client.calls], [True, False])
            self.assertEqual([Path(path).name for path in client.sent_files], [
                "CNC#2_2769-HDF.svg",
                "CNC#2_2769-HDF.png",
            ])
            self.assertEqual(client.messages, ["Черновой"])

    async def test_worker_records_manual_svg_outgoing_messages_in_audit(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(
                temp_dir=Path(root, "tmp"),
                media_dir=Path(root, "media"),
                parser_version="cnc-telegram-worker-v14",
                can_write_chat=False,
                business_timezone=timezone.utc,
            )
            events: list[str] = []

            async def complete_manual_svg_telegram_send(_request_id: str, _payload: dict[str, object]) -> dict[str, object]:
                events.append("complete")
                return {}

            async def audit_batch(batch: dict[str, object]) -> dict[str, object]:
                messages = batch.get("messages")
                if isinstance(messages, list) and any(
                    isinstance(message, dict) and message.get("reasonCode") == "reply_send_succeeded"
                    for message in messages
                ):
                    events.append("audit_sent")
                else:
                    events.append("audit")
                return {}

            worker.erp = SimpleNamespace(
                claim_manual_svg_telegram_sends=AsyncMock(return_value={
                    "capability": "cnc_manual_svg_telegram_send_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000006",
                        "packetId": "00000000-0000-4000-8000-000000000011",
                        "messageText": "ХДФ!!!\nФрезы для ХДФ: 8",
                        "files": [
                            manual_svg_send_file("gcode", "CNC#2_2769-HDF.nc", b"G01 X1"),
                            manual_svg_send_file("svg", "CNC#2_2769-HDF.svg", b"<svg></svg>"),
                            manual_svg_send_file("screenshot", "CNC#2_2769-HDF.jpg", png_bytes()),
                        ],
                    }],
                }),
                complete_manual_svg_telegram_send=AsyncMock(side_effect=complete_manual_svg_telegram_send),
                fail_manual_svg_telegram_send=AsyncMock(return_value={}),
                audit_batch=AsyncMock(side_effect=audit_batch),
            )
            audit_spool = AuditSpool(Path(root, "audit.sqlite3"), allow_unsafe_path=True)
            try:
                client = ManualSvgSendClient()

                await worker.process_manual_svg_telegram_send_requests(
                    client,
                    object(),
                    "-100",
                    audit_spool=audit_spool,
                    session_user_id="777",
                )

                worker.erp.audit_batch.assert_awaited()
                batches = [call.args[0] for call in worker.erp.audit_batch.await_args_list]
                messages = [message for batch in batches for message in batch.get("messages", [])]
                used_messages = [message for message in messages if message.get("reasonCode") == "reply_send_succeeded"]
                self.assertEqual([message["sourceMessageId"] for message in used_messages], ["8001", "8002", "8003", "9001"])
                self.assertEqual([message["messageType"] for message in used_messages], ["gcode", "svg", "image", "text"])
                self.assertTrue(all(message["outgoing"] for message in used_messages))
                self.assertTrue(all(message["status"] == "used" for message in used_messages))
                self.assertTrue(all(message["packetId"] == "00000000-0000-4000-8000-000000000011" for message in used_messages))
                self.assertIn("ХДФ!!!", used_messages[-1]["messageText"])
                self.assertTrue(any(
                    "скрин раскроя CNC#2_2769-HDF.jpg отправлен" in message["reasonMessage"]
                    for message in used_messages
                ))
                self.assertIn("audit_sent", events)
                self.assertIn("complete", events)
                self.assertLess(events.index("audit_sent"), events.index("complete"))
            finally:
                audit_spool.close()

    async def test_worker_rejects_manual_svg_file_hash_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            payload = manual_svg_send_file("svg", "bad.svg", b"<svg></svg>")
            payload["sha256"] = "0" * 64
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            worker.erp = SimpleNamespace(
                claim_manual_svg_telegram_sends=AsyncMock(return_value={
                    "capability": "cnc_manual_svg_telegram_send_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000004",
                        "messageText": "",
                        "files": [payload],
                    }],
                }),
                complete_manual_svg_telegram_send=AsyncMock(return_value={}),
                fail_manual_svg_telegram_send=AsyncMock(return_value={}),
            )
            client = ManualSvgSendClient()

            await worker.process_manual_svg_telegram_send_requests(client, object(), "-100")

            worker.erp.complete_manual_svg_telegram_send.assert_not_awaited()
            worker.erp.fail_manual_svg_telegram_send.assert_awaited_once()
            self.assertEqual(client.sent_files, [])
            self.assertIn("SHA-256 mismatch", worker.erp.fail_manual_svg_telegram_send.await_args.args[1])

    async def test_manual_svg_poll_loop_checks_queue_until_stopped(self) -> None:
        worker = object.__new__(CncTelegramWorker)
        worker.config = SimpleNamespace(manual_svg_send_poll_interval_seconds=0.01)
        stop_event = asyncio.Event()
        calls: list[str] = []

        async def process(_client: object, _entity: object, chat_id: str, **_kwargs: object) -> None:
            calls.append(chat_id)
            stop_event.set()

        worker.process_manual_svg_telegram_send_requests = AsyncMock(side_effect=process)

        await asyncio.wait_for(
            worker.poll_manual_svg_telegram_send_requests(object(), object(), "-100", stop_event),
            timeout=1,
        )

        self.assertEqual(calls, ["-100"])


def png_bytes() -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (1200, 800), "#2f6fed").save(stream, format="PNG")
    return stream.getvalue()


def manual_svg_send_file(kind: str, file_name: str, body: bytes) -> dict[str, object]:
    return {
        "fileId": "00000000-0000-4000-8000-000000000099",
        "kind": kind,
        "fileName": file_name,
        "contentType": "image/svg+xml" if kind == "svg" else "text/plain",
        "sizeBytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "base64Content": base64.b64encode(body).decode("ascii"),
    }


def with_base64_line_breaks(value: str) -> str:
    return "\n".join(value[index:index + 4] for index in range(0, len(value), 4))


if __name__ == "__main__":
    unittest.main()
