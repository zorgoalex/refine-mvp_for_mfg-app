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
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image

telethon_stub = types.ModuleType("telethon")
telethon_stub.TelegramClient = object
telethon_stub.utils = types.SimpleNamespace(get_peer_id=lambda entity: entity)
sys.modules.setdefault("telethon", telethon_stub)

from cnc_telegram_worker.cleanup import cleanup_temp_dir
from cnc_telegram_worker.audit import AuditSpool
from cnc_telegram_worker.erp_client import ErpResponseError, SessionLeaseLost
from cnc_telegram_worker.manual_send_observation import ManualSendBindingError, bind_manual_svg_sent_files
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


class BoundMessage:
    def __init__(self, message_id: int | None, body: bytes, file_name: str, chat_id: int, *, photo: bool) -> None:
        self.id = message_id
        self.body = body
        self.chat_id = chat_id
        self.file = SimpleNamespace(
            name=file_name,
            mime_type=mimetypes.guess_type(file_name)[0],
            size=len(body),
        )
        self.photo = object() if photo else None
        self.out = True

    async def download_media(self, *, file: object) -> object:
        file.write(self.body)  # type: ignore[attr-defined]
        return file


class BoundManualSvgSendClient(ManualSvgSendClient):
    def __init__(
        self,
        *,
        transform_photo: bool = True,
        fail_send_number: int | None = None,
        returned_chat_id: int = -100,
        message_ids: list[int | None] | None = None,
        returned_file_name: str | None = None,
        declared_media_size: int | None = None,
    ) -> None:
        super().__init__()
        self.messages_by_id: dict[int, BoundMessage] = {}
        self.refetch_calls: list[list[int]] = []
        self.transform_photo = transform_photo
        self.fail_send_number = fail_send_number
        self.returned_chat_id = returned_chat_id
        self.message_ids = message_ids
        self.returned_file_name = returned_file_name
        self.declared_media_size = declared_media_size

    async def send_file(self, _entity: object, files: list[str] | str, *, caption: str | None = None, force_document: bool = False):
        file_list = files if isinstance(files, list) else [files]
        self.sent_files.extend(file_list)
        self.calls.append({
            "files": file_list,
            "isBatch": isinstance(files, list),
            "caption": caption,
            "forceDocument": force_document,
        })
        if self.fail_send_number == len(self.calls):
            raise TimeoutError("simulated ambiguous Telegram send timeout")
        path = Path(file_list[0])
        source_body = path.read_bytes()
        body = b"transformed-telegram-photo" if not force_document and self.transform_photo else source_body
        message_id = (
            self.message_ids[len(self.calls) - 1]
            if self.message_ids is not None and len(self.message_ids) >= len(self.calls)
            else 8100 + len(self.calls)
        )
        message = BoundMessage(
            message_id, body, self.returned_file_name or path.name,
            self.returned_chat_id, photo=not force_document,
        )
        if self.declared_media_size is not None:
            message.file.size = self.declared_media_size
        if message.id is not None:
            self.messages_by_id[message.id] = message
        return message

    async def send_message(self, _entity: object, message: str):
        self.messages.append(message)
        sent = SimpleNamespace(
            id=9100 + len(self.messages),
            date=datetime(2026, 8, 14, 6, len(self.messages), tzinfo=timezone.utc),
            raw_text=message,
            chat_id=-100,
            out=True,
        )
        self.messages_by_id[sent.id] = sent  # Comments are never requested for media hashing.
        return sent

    async def get_messages(self, _entity: object, *, ids: list[int]):
        self.refetch_calls.append(list(ids))
        return [self.messages_by_id[message_id] for message_id in ids if message_id in self.messages_by_id]


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
                        **item_lease_fields(),
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
                        **item_lease_fields(),
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
                        "destinationChatId": "-100",
                        "cutJobId": 98,
                        "cutJobDisplayNumber": "104",
                        "messageText": "Фрезы для ХДФ: 8",
                        **item_lease_fields(),
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
            self.assertEqual(client.messages, ["Задание №104\nФрезы для ХДФ: 8"])

    async def test_worker_sends_screenshot_as_image_and_comment_last(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            worker.erp = SimpleNamespace(
                claim_manual_svg_telegram_sends=AsyncMock(return_value={
                    "capability": "cnc_manual_svg_telegram_send_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000005",
                        "destinationChatId": "-100",
                        "cutJobId": 97,
                        "cutJobDisplayNumber": "102",
                        "messageText": "Черновой",
                        **item_lease_fields(),
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
            self.assertEqual(client.messages, ["Задание №102\nЧерновой"])

    async def test_binding_capability_maps_actual_file_ids_and_hashes_transformed_photo(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            svg = manual_svg_send_file("svg", "cut.svg", b"<svg></svg>")
            svg["fileId"] = "00000000-0000-4000-8000-000000000101"
            screenshot = manual_svg_send_file("screenshot", "cut.png", png_bytes())
            screenshot["fileId"] = "00000000-0000-4000-8000-000000000102"
            gcode = manual_svg_send_file("gcode", "cut.nc", b"G01 X1")
            gcode["fileId"] = "00000000-0000-4000-8000-000000000103"
            worker.erp = SimpleNamespace(
                claim_manual_svg_telegram_sends=AsyncMock(return_value={
                    "capability": "cnc_manual_svg_telegram_send_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000021",
                        "destinationChatId": "-100",
                        "cutJobDisplayNumber": "104",
                        "messageText": "Files",
                        "observationBindingVersion": 1,
                        **item_lease_fields(),
                        # Server/file order differs from the worker dispatch order.
                        "files": [svg, screenshot, gcode],
                    }],
                }),
                complete_manual_svg_telegram_send=AsyncMock(return_value={}),
                fail_manual_svg_telegram_send=AsyncMock(return_value={}),
            )
            client = BoundManualSvgSendClient(transform_photo=True)

            await worker.process_manual_svg_telegram_send_requests(client, object(), "-100")

            completion = worker.erp.complete_manual_svg_telegram_send.await_args.args[1]
            self.assertEqual(completion["sentMessageIds"], ["8101", "8102", "8103", "9101"])
            self.assertEqual(client.refetch_calls, [[8101, 8102, 8103]])
            self.assertEqual(
                {row["fileId"]: row["messageId"] for row in completion["sentFiles"]},
                {
                    "00000000-0000-4000-8000-000000000101": "8102",
                    "00000000-0000-4000-8000-000000000102": "8103",
                    "00000000-0000-4000-8000-000000000103": "8101",
                },
            )
            photo_binding = next(row for row in completion["sentFiles"] if row["fileId"] == screenshot["fileId"])
            self.assertEqual(photo_binding["sourceSha256"], screenshot["sha256"])
            self.assertNotEqual(photo_binding["mediaSha256"], screenshot["sha256"])
            self.assertEqual(
                next(row for row in completion["sentFiles"] if row["fileId"] == svg["fileId"])["mediaSha256"],
                svg["sha256"],
            )
            self.assertEqual([call["forceDocument"] for call in client.calls], [True, True, False])
            self.assertEqual(len(client.calls), 3)
            worker.erp.fail_manual_svg_telegram_send.assert_not_awaited()

    async def test_binding_refetch_failure_settles_sent_with_registration_block(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            svg = manual_svg_send_file("svg", "cut.svg", b"<svg></svg>")
            svg["fileId"] = "00000000-0000-4000-8000-000000000111"
            worker.erp = SimpleNamespace(
                claim_manual_svg_telegram_sends=AsyncMock(return_value={
                    "capability": "cnc_manual_svg_telegram_send_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000022",
                        "destinationChatId": "-100",
                        "cutJobDisplayNumber": "105",
                        "messageText": "Files",
                        "observationBindingVersion": 1,
                        **item_lease_fields(),
                        "files": [svg],
                    }],
                }),
                complete_manual_svg_telegram_send=AsyncMock(return_value={}),
                fail_manual_svg_telegram_send=AsyncMock(return_value={}),
            )
            client = BoundManualSvgSendClient()
            client.get_messages = AsyncMock(side_effect=TimeoutError("refetch unavailable"))

            await worker.process_manual_svg_telegram_send_requests(client, object(), "-100")

            completion = worker.erp.complete_manual_svg_telegram_send.await_args.args[1]
            self.assertEqual(completion["observationBindingError"], "MEDIA_VERIFICATION_FAILED")
            self.assertNotIn("sentFiles", completion)
            self.assertEqual(completion["sentMessageIds"], ["8101", "9101"])
            worker.erp.fail_manual_svg_telegram_send.assert_not_awaited()

    async def test_post_send_chat_role_and_size_mismatches_settle_blocked(self) -> None:
        cases = (
            ("chat", {"returned_chat_id": -200}),
            ("role", {"returned_file_name": "cut.bin"}),
            ("size", {"declared_media_size": 15 * 1024 * 1024 + 1}),
        )
        for index, (reason, client_kwargs) in enumerate(cases, start=1):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as root:
                worker = object.__new__(CncTelegramWorker)
                worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
                svg = manual_svg_send_file("svg", "cut.svg", b"<svg></svg>")
                svg["fileId"] = f"00000000-0000-4000-8000-0000000002{index:02d}"
                worker.erp = SimpleNamespace(
                    claim_manual_svg_telegram_sends=AsyncMock(return_value={
                        "capability": "cnc_manual_svg_telegram_send_v1",
                        "tasks": [{
                            "requestId": f"00000000-0000-4000-8000-0000000003{index:02d}",
                            "destinationChatId": "-100",
                            "cutJobDisplayNumber": "108",
                            "messageText": "Files",
                            "observationBindingVersion": 1,
                            **item_lease_fields(),
                            "files": [svg],
                        }],
                    }),
                    complete_manual_svg_telegram_send=AsyncMock(return_value={}),
                    fail_manual_svg_telegram_send=AsyncMock(return_value={}),
                )
                client = BoundManualSvgSendClient(**client_kwargs)

                await worker.process_manual_svg_telegram_send_requests(client, object(), "-100")

                completion = worker.erp.complete_manual_svg_telegram_send.await_args.args[1]
                self.assertEqual(completion["observationBindingError"], "MEDIA_VERIFICATION_FAILED")
                self.assertNotIn("sentFiles", completion)
                self.assertEqual(len(client.calls), 1)
                worker.erp.fail_manual_svg_telegram_send.assert_not_awaited()

    async def test_ambiguous_missing_duplicate_or_oversized_dispatch_ids_are_not_settled(self) -> None:
        scenarios = (
            (["svg"], [None]),
            (["gcode", "svg"], [8101, 8101]),
            (["svg"], [2_147_483_648]),
        )
        for index, (kinds, returned_ids) in enumerate(scenarios, start=1):
            with self.subTest(returned_ids=returned_ids), tempfile.TemporaryDirectory() as root:
                worker = object.__new__(CncTelegramWorker)
                worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
                files = [
                    manual_svg_send_file(
                        kind,
                        "cut.nc" if kind == "gcode" else "cut.svg",
                        b"G01 X1" if kind == "gcode" else b"<svg></svg>",
                    )
                    for kind in kinds
                ]
                for file_index, file_item in enumerate(files, start=1):
                    file_item["fileId"] = f"00000000-0000-4000-8000-0000000004{index}{file_index}"
                worker.erp = SimpleNamespace(
                    claim_manual_svg_telegram_sends=AsyncMock(return_value={
                        "capability": "cnc_manual_svg_telegram_send_v1",
                        "tasks": [{
                            "requestId": f"00000000-0000-4000-8000-0000000005{index:02d}",
                            "destinationChatId": "-100",
                            "cutJobDisplayNumber": "109",
                            "messageText": "Files",
                            "observationBindingVersion": 1,
                            **item_lease_fields(),
                            "files": files,
                        }],
                    }),
                    complete_manual_svg_telegram_send=AsyncMock(return_value={}),
                    fail_manual_svg_telegram_send=AsyncMock(return_value={}),
                )
                client = BoundManualSvgSendClient(message_ids=returned_ids)

                await worker.process_manual_svg_telegram_send_requests(client, object(), "-100")

                self.assertEqual(len(client.calls), len(kinds))
                worker.erp.complete_manual_svg_telegram_send.assert_not_awaited()
                worker.erp.fail_manual_svg_telegram_send.assert_not_awaited()

    async def test_binding_helper_enforces_file_count_and_svg_source_hash(self) -> None:
        client = SimpleNamespace(get_messages=AsyncMock(return_value=[]))
        too_many_files = [
            {"fileId": f"file-{index}", "kind": "svg", "sha256": "a" * 64}
            for index in range(4)
        ]
        with self.assertRaises(ManualSendBindingError):
            await bind_manual_svg_sent_files(client, object(), "-100", too_many_files, [])
        client.get_messages.assert_not_awaited()

        body = b"<svg>physical source</svg>"
        message = BoundMessage(8201, body, "cut.svg", -100, photo=False)
        client.get_messages = AsyncMock(return_value=[message])
        requested = [{
            "fileId": "00000000-0000-4000-8000-000000000801",
            "kind": "svg",
            "sha256": "0" * 64,
        }]
        sent = [SimpleNamespace(
            file_id=requested[0]["fileId"],
            source_sha256=hashlib.sha256(body).hexdigest(),
            message=message,
        )]
        with self.assertRaises(ManualSendBindingError):
            await bind_manual_svg_sent_files(client, object(), "-100", requested, sent)

    async def test_binding_helper_enforces_aggregate_download_bytes_and_deadline(self) -> None:
        body = b"x" * (13 * 1024 * 1024)
        digest = hashlib.sha256(body).hexdigest()
        kinds = (("svg", "a.svg"), ("gcode", "a.nc"), ("screenshot", "a.png"))
        requested: list[dict[str, str]] = []
        sent: list[SimpleNamespace] = []
        messages: list[BoundMessage] = []
        for index, (kind, file_name) in enumerate(kinds, start=1):
            file_id = f"00000000-0000-4000-8000-00000000081{index}"
            requested.append({"fileId": file_id, "kind": kind, "sha256": digest})
            message = BoundMessage(8200 + index, body, file_name, -100, photo=kind == "screenshot")
            messages.append(message)
            sent.append(SimpleNamespace(file_id=file_id, source_sha256=digest, message=message))
        client = SimpleNamespace(get_messages=AsyncMock(return_value=messages))
        with self.assertRaises(ManualSendBindingError):
            await bind_manual_svg_sent_files(client, object(), "-100", requested, sent)

        async def slow_fetch(_entity: object, *, ids: list[int]) -> list[BoundMessage]:
            await asyncio.sleep(0.02)
            return messages

        client.get_messages = AsyncMock(side_effect=slow_fetch)
        with patch("cnc_telegram_worker.manual_send_observation.MANUAL_SEND_OBSERVATION_TIMEOUT_SECONDS", 0.001):
            with self.assertRaises(ManualSendBindingError):
                await bind_manual_svg_sent_files(client, object(), "-100", requested[:1], sent[:1])

    async def test_after_dispatch_send_error_is_not_reported_failed_or_resent(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            svg = manual_svg_send_file("svg", "cut.svg", b"<svg></svg>")
            svg["fileId"] = "00000000-0000-4000-8000-000000000121"
            gcode = manual_svg_send_file("gcode", "cut.nc", b"G01 X1")
            gcode["fileId"] = "00000000-0000-4000-8000-000000000122"
            worker.erp = SimpleNamespace(
                claim_manual_svg_telegram_sends=AsyncMock(return_value={
                    "capability": "cnc_manual_svg_telegram_send_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000023",
                        "destinationChatId": "-100",
                        "cutJobDisplayNumber": "106",
                        "messageText": "Files",
                        "observationBindingVersion": 1,
                        **item_lease_fields(),
                        "files": [svg, gcode],
                    }],
                }),
                complete_manual_svg_telegram_send=AsyncMock(return_value={}),
                fail_manual_svg_telegram_send=AsyncMock(return_value={}),
            )
            client = BoundManualSvgSendClient(fail_send_number=2)

            await worker.process_manual_svg_telegram_send_requests(client, object(), "-100")

            self.assertEqual(len(client.calls), 2)
            worker.erp.complete_manual_svg_telegram_send.assert_not_awaited()
            worker.erp.fail_manual_svg_telegram_send.assert_not_awaited()

    async def test_completion_retries_same_payload_without_resending(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            svg = manual_svg_send_file("svg", "cut.svg", b"<svg></svg>")
            svg["fileId"] = "00000000-0000-4000-8000-000000000131"
            error = ErpResponseError(httpx.Response(503, request=httpx.Request("POST", "https://erp.test")), "complete")
            complete = AsyncMock(side_effect=[error, {}])
            worker.erp = SimpleNamespace(
                claim_manual_svg_telegram_sends=AsyncMock(return_value={
                    "capability": "cnc_manual_svg_telegram_send_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000024",
                        "destinationChatId": "-100",
                        "cutJobDisplayNumber": "107",
                        "messageText": "Files",
                        "observationBindingVersion": 1,
                        **item_lease_fields(),
                        "files": [svg],
                    }],
                }),
                complete_manual_svg_telegram_send=complete,
                fail_manual_svg_telegram_send=AsyncMock(return_value={}),
            )
            client = BoundManualSvgSendClient()

            await worker.process_manual_svg_telegram_send_requests(client, object(), "-100")

            self.assertEqual(complete.await_count, 2)
            self.assertEqual(complete.await_args_list[0].args, complete.await_args_list[1].args)
            self.assertEqual(len(client.calls), 1)
            worker.erp.fail_manual_svg_telegram_send.assert_not_awaited()

    async def test_completion_409_and_session_revocation_stop_retry(self) -> None:
        errors = (
            ErpResponseError(httpx.Response(409, request=httpx.Request("POST", "https://erp.test")), "complete"),
            SessionLeaseLost("session revoked"),
        )
        for index, error in enumerate(errors, start=1):
            with self.subTest(error=type(error).__name__), tempfile.TemporaryDirectory() as root:
                worker = object.__new__(CncTelegramWorker)
                worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
                svg = manual_svg_send_file("svg", "cut.svg", b"<svg></svg>")
                svg["fileId"] = f"00000000-0000-4000-8000-0000000006{index:02d}"
                complete = AsyncMock(side_effect=error)
                worker.erp = SimpleNamespace(
                    claim_manual_svg_telegram_sends=AsyncMock(return_value={
                        "capability": "cnc_manual_svg_telegram_send_v1",
                        "tasks": [{
                            "requestId": f"00000000-0000-4000-8000-0000000007{index:02d}",
                            "destinationChatId": "-100",
                            "cutJobDisplayNumber": "110",
                            "messageText": "Files",
                            "observationBindingVersion": 1,
                            **item_lease_fields(),
                            "files": [svg],
                        }],
                    }),
                    complete_manual_svg_telegram_send=complete,
                    fail_manual_svg_telegram_send=AsyncMock(return_value={}),
                )
                client = BoundManualSvgSendClient()

                if isinstance(error, SessionLeaseLost):
                    with self.assertRaises(SessionLeaseLost):
                        await worker.process_manual_svg_telegram_send_requests(client, object(), "-100")
                else:
                    await worker.process_manual_svg_telegram_send_requests(client, object(), "-100")

                self.assertEqual(complete.await_count, 1)
                self.assertEqual(len(client.calls), 1)
                worker.erp.fail_manual_svg_telegram_send.assert_not_awaited()

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

            async def complete_manual_svg_telegram_send(
                _request_id: str,
                _payload: dict[str, object],
                _item_lease: object,
            ) -> dict[str, object]:
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
                        "destinationChatId": "-100",
                        "cutJobId": 97,
                        "cutJobDisplayNumber": "102",
                        "messageText": "ХДФ!!!\nФрезы для ХДФ: 8",
                        **item_lease_fields(),
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
                self.assertTrue(all(message["cutJobId"] == "97" for message in used_messages))
                self.assertIn("ХДФ!!!", used_messages[-1]["messageText"])
                self.assertIn("Задание №102", used_messages[-1]["messageText"])
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
                        "destinationChatId": "-100",
                        "messageText": "",
                        **item_lease_fields(),
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

    async def test_worker_rejects_manual_svg_destination_mismatch_without_sending(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            worker.erp = SimpleNamespace(
                claim_manual_svg_telegram_sends=AsyncMock(return_value={
                    "capability": "cnc_manual_svg_telegram_send_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000007",
                        "destinationChatId": "-200",
                        "messageText": "",
                        **item_lease_fields(),
                        "files": [manual_svg_send_file("svg", "safe.svg", b"<svg></svg>")],
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
            self.assertIn("different Telegram chat", worker.erp.fail_manual_svg_telegram_send.await_args.args[1])

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


def item_lease_fields() -> dict[str, object]:
    return {
        "itemLeaseToken": "i" * 64,
        "itemLeaseGeneration": 1,
        "itemLeaseOwner": "00000000-0000-4000-8000-000000000005",
    }


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
